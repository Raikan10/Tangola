import { useEffect, useState, useRef } from 'react'
import toast, { Toaster } from 'react-hot-toast'
import ReactMarkdown from 'react-markdown'
import './index.css'

declare global {
  interface Window {
    electronAPI: any;
  }
}

type Transcript = { id: number, text: string, final: boolean };
type Meeting = { id: string, title: string, date: string, transcripts: Transcript[], summary?: string };

type Settings = {
  sarvamApiKey: string;
  geminiApiKey: string;
  openaiApiKey: string;
  defaultSummarizer: 'gemini' | 'openai';
};

function App() {
  const [engineStatus, setEngineStatus] = useState('Disconnected');
  const [providerStatus, setProviderStatus] = useState('Disconnected');
  const [isRecording, setIsRecording] = useState(false);
  
  const [debugWav, setDebugWav] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    sarvamApiKey: '', geminiApiKey: '', openaiApiKey: '', defaultSummarizer: 'gemini'
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>('transcript');
  const [isSummarizing, setIsSummarizing] = useState(false);
  
  const [liveTranscripts, setLiveTranscripts] = useState<Transcript[]>([]);
  const nextId = useRef(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollLocked, setScrollLocked] = useState(true);

  const fetchMeetings = async () => {
    const data = await window.electronAPI.getMeetings();
    setMeetings(data);
  };

  useEffect(() => {
    fetchMeetings();

    window.electronAPI.getSettings().then((s: Settings) => setSettings(s));

    window.electronAPI.getStatus().then((status: any) => {
      setEngineStatus(status.pythonConnected ? 'Connected' : 'Disconnected');
      setIsRecording(status.recording);
      if (status.activeMeetingId) {
         setActiveMeetingId(status.activeMeetingId);
      }
    });

    const onEngineStatus = (_event: any, status: string) => setEngineStatus(status);
    const onProviderStatus = (_event: any, status: string) => setProviderStatus(status);
    
    const onTranscript = (_event: any, { text, isFinal }: { text: string, isFinal: boolean }) => {
      setLiveTranscripts(prev => {
        const last = prev[prev.length - 1];
        if (last && !last.final) {
          const newArr = [...prev];
          newArr[newArr.length - 1] = { ...last, text, final: isFinal };
          return newArr;
        } else {
          return [...prev, { id: nextId.current++, text, final: isFinal }];
        }
      });
    };

    const cleanEngine = window.electronAPI.onEngineStatus(onEngineStatus);
    const cleanProvider = window.electronAPI.onProviderStatus(onProviderStatus);
    const cleanTranscript = window.electronAPI.onTranscript(onTranscript);

    return () => {
      cleanEngine();
      cleanProvider();
      cleanTranscript();
    };
  }, []);

  useEffect(() => {
    const m = meetings.find(x => x.id === activeMeetingId);
    if (m) {
      setLiveTranscripts(m.transcripts);
      if (m.summary && !isRecording && activeTab === 'transcript') {
         setActiveTab('summary');
      } else if (!m.summary) {
         setActiveTab('transcript');
      }
    } else {
      setLiveTranscripts([]);
      setActiveTab('transcript');
    }
  }, [activeMeetingId, meetings, isRecording]);

  useEffect(() => {
    if (scrollLocked && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveTranscripts, scrollLocked]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
    setScrollLocked(isAtBottom);
  };

  const handleSaveSettings = async () => {
    await window.electronAPI.saveSettings(settings);
    setIsSettingsOpen(false);
    toast.success('Settings saved successfully!');
  };

  const handleCreateMeeting = async () => {
    const newMeeting = await window.electronAPI.createMeeting();
    await fetchMeetings();
    setActiveMeetingId(newMeeting.id);
  };

  const handleStartSession = async () => {
    if (!isRecording && activeMeetingId) {
      await window.electronAPI.setActiveMeeting(activeMeetingId);
      const success = await window.electronAPI.startCapture(activeMeetingId);
      if (success) {
        setIsRecording(true);
        toast.success('Recording started');
        setScrollLocked(true);
      }
    }
  };

  const handleStopSession = async () => {
    if (isRecording) {
      const success = await window.electronAPI.stopCapture();
      if (success) {
         setIsRecording(false);
         await fetchMeetings();
         toast('Recording paused', { icon: '⏸️' });
      }
    }
  };

  const handleSummarize = async () => {
    if (!activeMeetingId || isSummarizing) return;
    setIsSummarizing(true);
    toast.loading('Generating structured notes...', { id: 'summary-toast' });
    const res = await window.electronAPI.generateSummary(activeMeetingId);
    if (res.success) {
      toast.success('Notes generated!', { id: 'summary-toast' });
      await fetchMeetings();
      setActiveTab('summary');
    } else {
      toast.error('Summarization failed: ' + res.error, { id: 'summary-toast' });
    }
    setIsSummarizing(false);
  };

  const handleDebugToggle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    await window.electronAPI.setDebugWav(enabled);
    setDebugWav(enabled);
    if (enabled) {
      toast('WAV Debugging enabled.', { icon: '🐛' });
    }
  };

  const handleOpenLogs = async () => {
    await window.electronAPI.openLogs();
  };

  const handleDeleteMeeting = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this session?')) return;
    const res = await window.electronAPI.deleteMeeting(id);
    if (res.success) {
      toast.success('Meeting deleted');
      await fetchMeetings();
      if (activeMeetingId === id) {
        setActiveMeetingId(null);
      }
    } else {
      toast.error('Failed to delete: ' + res.error);
    }
  };

  const activeMeeting = meetings.find(m => m.id === activeMeetingId);

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="logo">Tangola.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
            <button className="new-meeting-btn" onClick={handleCreateMeeting}>
              <span>+</span> New Meeting
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button 
                onClick={() => setIsSettingsOpen(true)}
                style={{
                  flex: 1,
                  background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)',
                  padding: '8px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
                }}
              >
                <span>⚙️</span> Settings
              </button>
              <button 
                onClick={handleOpenLogs}
                style={{
                  flex: 1,
                  background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)',
                  padding: '8px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
                }}
              >
                <span>📁</span> Logs
              </button>
            </div>
          </div>
        </div>
        <div className="meeting-list">
          {meetings.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>
              No meetings yet.
            </div>
          )}
          {meetings.slice().reverse().map(m => (
            <div 
              key={m.id} 
              className={`meeting-item ${m.id === activeMeetingId ? 'active' : ''}`}
              onClick={() => setActiveMeetingId(m.id)}
            >
              <div className="meeting-content">
                <div className="meeting-title">{m.title}</div>
                <div className="meeting-date">{new Date(m.date).toLocaleDateString()}</div>
              </div>
              <button 
                className="delete-meeting-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteMeeting(m.id);
                }}
                disabled={isRecording && m.id === activeMeetingId}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        <header className="top-bar">
          <div className="meeting-info">
            <h2>{activeMeeting?.title || 'Welcome back'}</h2>
            {activeMeeting && (
              <div className="meeting-subtitle">
                 {new Date(activeMeeting.date).toLocaleString()}
              </div>
            )}
            <div className="status-badges">
              <span className={`badge ${engineStatus === 'Connected' ? 'connected' : ''}`} title="Python Engine Connection">
                Engine: {engineStatus}
              </span>
              <span className={`badge ${providerStatus === 'connected' || providerStatus === 'listening' ? 'connected' : ''}`} title="Audio Provider Streaming">
                Provider: {providerStatus}
              </span>
            </div>
          </div>

          <div className="settings-controls">
             <label className="setting-label checkbox-label" title="Save raw PCM data as WAV file to user data folder.">
               <input type="checkbox" checked={debugWav} onChange={handleDebugToggle} />
               Debug WAV
             </label>
             {activeMeetingId && (
               <button 
                 className={`record-btn ${isRecording ? 'stop' : 'start'}`}
                 onClick={isRecording ? handleStopSession : handleStartSession}
               >
                 <div style={{ 
                   width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'white',
                   animation: isRecording ? 'pulse 1.5s infinite' : 'none'
                 }} />
                 {isRecording ? 'Stop Session' : 'Start Session'}
               </button>
             )}
          </div>
        </header>

        <main className="transcript-container">
          {!activeMeetingId ? (
            <div className="empty-state">
              <div className="empty-icon">📝</div>
              <h3>Select or create a meeting.</h3>
              <p>Click "New Meeting" in the sidebar to get started.</p>
            </div>
          ) : liveTranscripts.length === 0 && !isRecording ? (
            <div className="empty-state" style={{opacity: 0.8}}>
              <div className="empty-icon">🎙️</div>
              <h3>Ready to listen.</h3>
              <p>Click "Start Session" above to begin real-time translation.</p>
            </div>
          ) : (
            <div className="transcript-area">
              <div className="tabs">
                <button 
                  className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`} 
                  onClick={() => setActiveTab('transcript')}
                >
                  Transcript {!scrollLocked && ' (Scroll Paused)'}
                </button>
                <button 
                  className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`} 
                  onClick={() => setActiveTab('summary')}
                  disabled={!activeMeeting?.summary && isRecording}
                >
                  Meeting Notes
                </button>

                {!activeMeeting?.summary && !isRecording && liveTranscripts.length > 0 && (
                  <button 
                    className="generate-btn" 
                    onClick={handleSummarize} 
                    disabled={isSummarizing}
                  >
                    {isSummarizing ? "⏳ Generating..." : "Generate Notes ✨"}
                  </button>
                )}
              </div>

              {activeTab === 'transcript' && (
                <div className="transcript-paper" ref={scrollRef} onScroll={handleScroll}>
                  {liveTranscripts.map((t) => (
                    <div key={t.id} className={`transcript-line ${!t.final ? 'partial' : ''}`}>
                      {t.text}
                    </div>
                  ))}
                  {isRecording && <div style={{ height: '40px' }} />}
                </div>
              )}

              {activeTab === 'summary' && (
                <div className="summary-paper">
                  {activeMeeting?.summary ? (
                    <div className="markdown-content">
                      <ReactMarkdown>{activeMeeting.summary}</ReactMarkdown>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '40px' }}>
                      No summary available yet. Click "Generate Notes" above.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
        
        {/* Settings Modal */}
        {isSettingsOpen && (
          <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <h3>API Provider Settings</h3>
              
              <div className="settings-group">
                <label>Sarvam API Key (Live Translation)</label>
                <input 
                  type="password" 
                  className="settings-input" 
                  value={settings.sarvamApiKey} 
                  onChange={e => setSettings({...settings, sarvamApiKey: e.target.value})} 
                  placeholder="sk-sarvam-..." 
                />
              </div>

              <div className="settings-group" style={{marginTop: '24px'}}>
                <label>Primary Summarizer</label>
                <select 
                  className="settings-select"
                  value={settings.defaultSummarizer}
                  onChange={e => setSettings({...settings, defaultSummarizer: e.target.value as 'gemini' | 'openai'})}
                >
                  <option value="gemini">Google Gemini (Flash)</option>
                  <option value="openai">OpenAI (GPT-4o-mini)</option>
                </select>
              </div>

              <div className="settings-group">
                <label>Gemini API Key</label>
                <input 
                  type="password" 
                  className="settings-input" 
                  value={settings.geminiApiKey} 
                  onChange={e => setSettings({...settings, geminiApiKey: e.target.value})} 
                  placeholder="AIzaSy..." 
                />
              </div>

              <div className="settings-group">
                <label>OpenAI API Key (Fallback)</label>
                <input 
                  type="password" 
                  className="settings-input" 
                  value={settings.openaiApiKey} 
                  onChange={e => setSettings({...settings, openaiApiKey: e.target.value})} 
                  placeholder="sk-proj-..." 
                />
              </div>

              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => setIsSettingsOpen(false)}>Cancel</button>
                <button className="btn-primary" onClick={handleSaveSettings}>Save Settings</button>
              </div>
            </div>
          </div>
        )}

        <Toaster position="bottom-right" toastOptions={{
          style: {
            background: '#1a1d23', color: '#fff', border: '1px solid var(--border-color)'
          }
        }} />

        <style>{`
          @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.4); opacity: 0.5; }
            100% { transform: scale(1); opacity: 1; }
          }
        `}</style>
      </div>
    </div>
  )
}

export default App
