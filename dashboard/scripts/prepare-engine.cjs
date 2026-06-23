const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration for standalone Python distributions
// We use python-build-standalone (https://github.com/indygreg/python-build-standalone)
const PYTHON_VERSION = '3.11.9';
const REPOS = 'https://github.com/indygreg/python-build-standalone/releases/download/20240415';

const URLS = {
  'darwin-arm64': `${REPOS}/cpython-${PYTHON_VERSION}+20240415-aarch64-apple-darwin-install_only.tar.gz`,
  'darwin-x64': `${REPOS}/cpython-${PYTHON_VERSION}+20240415-x86_64-apple-darwin-install_only.tar.gz`,
  'win32-x64': `${REPOS}/cpython-${PYTHON_VERSION}+20240415-x86_64-pc-windows-msvc-shared-install_only.tar.gz`,
};

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download: ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function prepareEngine(targetPlatform = process.platform, targetArch = process.arch) {
  const key = `${targetPlatform}-${targetArch === 'arm64' ? 'arm64' : 'x64'}`;
  const url = URLS[key];

  if (!url) {
    throw new Error(`Unsupported platform/architecture: ${key}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const engineSrc = path.resolve(projectRoot, '..', 'engine');
  const distEngine = path.resolve(projectRoot, 'dist-engine');
  const pythonDir = path.resolve(distEngine, 'python');
  const archive = path.resolve(projectRoot, `python-${key}.tar.gz`);

  console.log(`[PrepareEngine] Target: ${key} (Host: ${process.platform})`);
  console.log(`[PrepareEngine] Engine Source: ${engineSrc}`);
  console.log(`[PrepareEngine] Output: ${distEngine}`);

  // 1. Clean dist-engine
  if (fs.existsSync(distEngine)) {
    console.log('[PrepareEngine] Cleaning old dist-engine...');
    fs.rmSync(distEngine, { recursive: true, force: true });
  }
  fs.mkdirSync(distEngine, { recursive: true });

  // 2. Download and Extract Standalone Python
  if (!fs.existsSync(archive)) {
    console.log(`[PrepareEngine] Downloading standalone Python from ${url}...`);
    await downloadFile(url, archive);
  }

  console.log('[PrepareEngine] Extracting Python...');
  // Force extraction into dist-engine. Use paths relative to projectRoot so a
  // Windows drive letter (e.g. D:\) in the absolute path isn't misread by GNU
  // tar (used via Git bash on CI) as a remote host ("Cannot connect to D:").
  execSync(
    `tar -xzf "${path.basename(archive)}" -C "${path.relative(projectRoot, distEngine)}"`,
    { cwd: projectRoot }
  );

  // python-build-standalone usually extracts into a 'python' folder
  // If it extracts into something else, we might need to find it and rename it.
  // But usually it's 'python/install/...' or just 'python/...'
  // In our case, the tarball from indygreg extracts a 'python' directory.

  // 3. Copy Engine scripts
  console.log('[PrepareEngine] Copying engine scripts...');
  const filesToCopy = ['main.py', 'adapter.py', 'pyproject.toml'];
  filesToCopy.forEach(f => {
    const src = path.join(engineSrc, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(distEngine, f));
    }
  });

  // 4. Install requirements
  console.log('[PrepareEngine] Installing dependencies...');
  
  const isCrossCompiling = targetPlatform !== process.platform;
  const deps = ["numpy>=2.0.0", "pyaudio>=0.2.14", "soundcard>=0.4.5", "websockets>=13.0"];

  if (isCrossCompiling) {
    console.log(`[PrepareEngine] Cross-compiling detected (Host:${process.platform} -> Target:${targetPlatform})`);
    console.log(`[PrepareEngine] Using 'pip install --platform' to download ${targetPlatform} wheels...`);
    
    // For cross-compiling, we use the HOST's python/pip to download wheels into the target's site-packages
    const pipPlatform = targetPlatform === 'win32' ? 'win_amd64' : (targetPlatform === 'darwin' ? (targetArch === 'arm64' ? 'macosx_11_0_arm64' : 'macosx_10_9_x86_64') : 'manylinux2014_x86_64');
    
    // We need to find the site-packages directory in the target python distribution
    let sitePackages;
    if (targetPlatform === 'win32') {
      sitePackages = path.join(pythonDir, 'Lib', 'site-packages');
    } else {
      // For Linux/Mac standalone, it's usually lib/python3.11/site-packages
      const libDir = path.join(pythonDir, 'lib');
      const pythonLibDir = fs.readdirSync(libDir).find(d => d.startsWith('python3.'));
      sitePackages = path.join(libDir, pythonLibDir, 'site-packages');
    }

    if (!fs.existsSync(sitePackages)) {
      fs.mkdirSync(sitePackages, { recursive: true });
    }

    const pipCmd = `python3 -m pip install --target "${sitePackages}" --platform ${pipPlatform} --only-binary=:all: --python-version 3.11 --upgrade ${deps.join(' ')}`;
    console.log(`[PrepareEngine] Running: ${pipCmd}`);
    execSync(pipCmd, { stdio: 'inherit' });

  } else {
    // Normal installation using the target python (which is also the host python)
    const pythonBin = targetPlatform === 'win32' 
      ? path.join(pythonDir, 'python.exe')
      : path.join(pythonDir, 'bin', 'python3');

    try {
      execSync(`"${pythonBin}" -m pip install --upgrade pip`, { stdio: 'inherit' });
      console.log(`[PrepareEngine] Installing: ${deps.join(' ')}`);
      execSync(`"${pythonBin}" -m pip install ${deps.map(d => `"${d}"`).join(' ')}`, { stdio: 'inherit' });
    } catch (err) {
      console.error('[PrepareEngine] Failed to install dependencies:', err.message);
      throw err;
    }
  }

  // Apple Silicon / Intel - Ensure native portaudio libs are bundled
  if (targetPlatform === 'darwin') {
    console.log('[PrepareEngine] Bundling native dylibs for portability...');
    const libPath = path.join(pythonDir, 'lib');
    const possibleBrewPaths = ['/opt/homebrew/lib/libportaudio.2.dylib', '/usr/local/lib/libportaudio.2.dylib'];
    for (const p of possibleBrewPaths) {
      if (fs.existsSync(p)) {
        console.log(`[PrepareEngine] Found native lib at ${p}, copying...`);
        fs.copyFileSync(p, path.join(libPath, 'libportaudio.2.dylib'));
        break;
      }
    }
  }

  // 5. Hardened signing cleanup
  console.log('[PrepareEngine] Stripping __pycache__, tests, and bytecode...');
  const stripEngine = (dir) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (file === '__pycache__' || file === 'tests' || file === 'test' || file === 'idlelib') {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            stripEngine(fullPath);
          }
        } else if (file.endsWith('.pyc') || file.endsWith('.pyo')) {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {}
    });
  };
  stripEngine(distEngine);

  console.log('[PrepareEngine] DONE! Standalone engine is ready in dist-engine/');
}

// Parse arguments: node prepare-engine.cjs [platform] [arch]
const args = process.argv.slice(2);
const targetPlatform = args[0] || process.platform;
const targetArch = args[1] || (targetPlatform === 'win32' ? 'x64' : process.arch);

prepareEngine(targetPlatform, targetArch).catch(err => {
  console.error('[PrepareEngine] FAILED:', err);
  process.exit(1);
});
