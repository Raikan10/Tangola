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

async function prepareEngine() {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  const url = URLS[key];

  if (!url) {
    throw new Error(`Unsupported platform/architecture: ${key}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const engineSrc = path.resolve(projectRoot, '..', 'engine');
  const distEngine = path.resolve(projectRoot, 'dist-engine');
  const pythonDir = path.resolve(distEngine, 'python');
  const archive = path.resolve(projectRoot, `python-${key}.tar.gz`);

  console.log(`[PrepareEngine] Target: ${key}`);
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
  if (platform === 'win32') {
    // Windows: Use tar (if available) or a library. Modern Windows has tar.
    execSync(`tar -xzf "${archive}" -C "${distEngine}"`);
  } else {
    execSync(`tar -xzf "${archive}" -C "${distEngine}"`);
  }

  // Rename the extracted 'python' directory to 'python' inside dist-engine if it extracts as something else
  // python-build-standalone usually extracts as 'python'
  if (!fs.existsSync(pythonDir) && fs.existsSync(path.resolve(distEngine, 'python'))) {
    // Already correct
  }

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
  console.log('[PrepareEngine] Installing dependencies into standalone Python...');
  const pythonBin = platform === 'win32' 
    ? path.join(pythonDir, 'python.exe')
    : path.join(pythonDir, 'bin', 'python3');

  // We upgrade pip and install requirements
  // Note: we use our engine source to find the requirements
  try {
    execSync(`"${pythonBin}" -m pip install --upgrade pip`, { stdio: 'inherit' });
    const deps = ["numpy>=2.4.4", "pyaudio>=0.2.14", "soundcard>=0.4.5", "websockets>=16.0"];
    console.log(`[PrepareEngine] Installing: ${deps.join(' ')}`);
    execSync(`"${pythonBin}" -m pip install ${deps.map(d => `"${d}"`).join(' ')}`, { stdio: 'inherit' });
    console.log('[PrepareEngine] Dependencies installed successfully.');
    
    // Apple Silicon / Intel - Ensure native portaudio libs are bundled
    if (platform === 'darwin') {
      console.log('[PrepareEngine] Bundling native dylibs for portability...');
      const libPath = path.join(pythonDir, 'lib');
      // Search for libportaudio (usually in brew path on dev machine)
      const possibleBrewPaths = ['/opt/homebrew/lib/libportaudio.2.dylib', '/usr/local/lib/libportaudio.2.dylib'];
      for (const p of possibleBrewPaths) {
        if (fs.existsSync(p)) {
          console.log(`[PrepareEngine] Found native lib at ${p}, copying...`);
          fs.copyFileSync(p, path.join(libPath, 'libportaudio.2.dylib'));
          break;
        }
      }
    }
  } catch (err) {
    console.error('[PrepareEngine] Failed to install dependencies:', err.message);
    throw err;
  }

  // 5. Hardened signing cleanup (Remove .pyc, __pycache__, and tests to avoid "Timestamp expected" errors)
  console.log('[PrepareEngine] Stripping __pycache__, tests, and bytecode for faster signing...');
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
      } catch (e) {
        // Ignore errors for symlinks or permission issues during cleanup
      }
    });
  };
  stripEngine(distEngine);

  // 6. Cleanup
  console.log('[PrepareEngine] Finalizing...');

  console.log('[PrepareEngine] DONE! Standalone engine is ready in dist-engine/');
}

prepareEngine().catch(err => {
  console.error('[PrepareEngine] FAILED:', err);
  process.exit(1);
});
