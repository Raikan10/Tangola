import { useEffect, useState, useRef } from 'react'
import toast, { Toaster } from 'react-hot-toast'
import ReactMarkdown from 'react-markdown'
import './index.css'
import './index.css'

declare global {
  interface Window {
    electronAPI: any;
  }
}

type Transcript = { id: number, text: string, final: boolean };
type Meeting = { id: string, title: string, date: string, transcripts: Transcript[], summary?: string };

function App() {
  const [engineStatus, setEngineStatus] = useState('Disconnected');
  const [providerStatus, setProviderStatus] = useState('Disconnected');
  const [isRecording, setIsRecording] = useState(false);
  
  const [providerType, setProviderType] = useState<'sarvam' | 'openai'>('sarvam');
  const [debugWav, setDebugWav] = useState(false);
  
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>('transcript');
  const [isSummarizing, setIsSummarizing] = useState(false);
  
  const [liveTranscripts, setLiveTranscripts] = useState<Transcript[]>([]);
  const nextId = useRef(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchMeetings = async () => {
    const data = await window.electronAPI.getMeetings();
    setMeetings(data);
  };

  useEffect(() => {
    fetchMeetings();

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
      // Automatically switch to summary tab if valid summary exists when not recording
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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveTranscripts]);

  const handleCreateMeeting = async () => {
    const newMeeting = await window.electronAPI.createMeeting();
    await fetchMeetings();
    setActiveMeetingId(newMeeting.id);
  };

  const handleStart = async () => {
    if (!isRecording) {
      let mId = activeMeetingId;
      if (!mId) {
         const newMeeting = await window.electronAPI.createMeeting();
         await fetchMeetings();
         mId = newMeeting.id;
         setActiveMeetingId(mId);
      } else {
         await window.electronAPI.setActiveMeeting(mId);
      }
      
      const success = await window.electronAPI.startCapture(mId);
      if (success) {
        setIsRecording(true);
        toast.success('Session started');
      }
    }
  };

  const handleStop = async () => {
    if (isRecording) {
      const success = await window.electronAPI.stopCapture();
      if (success) {
         setIsRecording(false);
         await fetchMeetings();
         toast('Session ended', { icon: '🛑' });
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

  const handleProviderChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const p = e.target.value as 'sarvam' | 'openai';
    const res = await window.electronAPI.setProvider(p);
    if (res && res.success) {
      setProviderType(p);
      toast.success(`Switched to ${p === 'sarvam' ? 'Sarvam AI' : 'OpenAI Whisper'}`, { id: 'provider-switch' });
    } else {
      toast.error(`Provider switch failed: ${res?.error}`, { id: 'provider-switch' });
    }
  };

  const handleDebugToggle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    await window.electronAPI.setDebugWav(enabled);
    setDebugWav(enabled);
    if (enabled) {
      toast('WAV Debugging enabled. Audio will be saved after session.', { icon: '🐛' });
    }
  };

  const activeMeeting = meetings.find(m => m.id === activeMeetingId);

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="logo">Tangola.</div>
          <button className="new-meeting-btn" onClick={handleCreateMeeting}>
            <span>+</span> New Session
          </button>
        </div>
        <div className="meeting-list">
          {meetings.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>
              No sessions yet.
            </div>
          )}
          {meetings.slice().reverse().map(m => (
            <div 
              key={m.id} 
              className={`meeting-item ${m.id === activeMeetingId ? 'active' : ''}`}
              onClick={() => setActiveMeetingId(m.id)}
            >
              <div className="meeting-title">{m.title}</div>
              <div className="meeting-date">{new Date(m.date).toLocaleDateString()}</div>
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
              <span className={`badge ${engineStatus === 'Connected' ? 'connected' : ''}`}>
                Engine: {engineStatus}
              </span>
              <span className={`badge ${providerStatus === 'connected' || providerStatus === 'listening' ? 'connected' : ''}`}>
                Provider: {providerStatus}
              </span>
            </div>
          </div>

          <div className="settings-controls">
             <label className="setting-label">
               <select value={providerType} onChange={handleProviderChange} disabled={isRecording} className="provider-select">
                 <option value="sarvam">Sarvam AI (Streaming)</option>
                 {import.meta.env.VITE_ENABLE_OPENAI === 'true' && (
                   <option value="openai">OpenAI Whisper (Fallback)</option>
                 )}
               </select>
             </label>
             <label className="setting-label checkbox-label" title="Save raw PCM data as WAV file to user data folder.">
               <input type="checkbox" checked={debugWav} onChange={handleDebugToggle} />
               Debug WAV
             </label>
          </div>

          <button 
            className={`record-btn ${isRecording ? 'stop' : 'start'}`}
            onClick={isRecording ? handleStop : handleStart}
            disabled={!activeMeetingId && isRecording}
          >
            <div style={{ 
              width: '10px', 
              height: '10px', 
              borderRadius: '50%', 
              backgroundColor: 'white',
              animation: isRecording ? 'pulse 1.5s infinite' : 'none'
            }} />
            {isRecording ? 'Stop Session' : 'Start Session'}
          </button>
        </header>

        <main className="transcript-container">
          {liveTranscripts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎙️</div>
              <h3>Ready to listen.</h3>
              <p>Start a session to begin real-time translation.</p>
            </div>
          ) : (
            <div className="transcript-area">
              <div className="tabs">
                <button 
                  className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`} 
                  onClick={() => setActiveTab('transcript')}
                >
                  Raw Transcript
                </button>
                <button 
                  className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`} 
                  onClick={() => setActiveTab('summary')}
                  disabled={!activeMeeting?.summary && isRecording}
                >
                  Meeting Notes
                </button>

                {!activeMeeting?.summary && !isRecording && (
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
                <div className="transcript-paper" ref={scrollRef}>
                  {liveTranscripts.map((t) => (
                    <div 
                      key={t.id} 
                      className={`transcript-line ${!t.final ? 'partial' : ''}`}
                    >
                      {t.text}
                    </div>
                  ))}
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
        <Toaster position="bottom-right" toastOptions={{
          style: {
            background: '#1a1d23',
            color: '#fff',
            border: '1px solid var(--border-color)'
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
