import { useEffect, useState, useRef } from 'react'
import './index.css'

declare global {
  interface Window {
    electronAPI: any;
  }
}

type Transcript = { id: number, text: string, final: boolean };
type Meeting = { id: string, title: string, date: string, transcripts: Transcript[] };

function App() {
  const [engineStatus, setEngineStatus] = useState('Disconnected');
  const [providerStatus, setProviderStatus] = useState('Disconnected');
  const [isRecording, setIsRecording] = useState(false);
  
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  
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
    } else {
      setLiveTranscripts([]);
    }
  }, [activeMeetingId, meetings]);

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
      if (success) setIsRecording(true);
    }
  };

  const handleStop = async () => {
    if (isRecording) {
      const success = await window.electronAPI.stopCapture();
      if (success) {
         setIsRecording(false);
         await fetchMeetings();
      }
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
            <div className="status-badges">
              <span className={`badge ${engineStatus === 'Connected' ? 'connected' : ''}`}>
                Engine: {engineStatus}
              </span>
              <span className={`badge ${providerStatus === 'connected' || providerStatus === 'listening' ? 'connected' : ''}`}>
                Provider: {providerStatus}
              </span>
            </div>
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

        <main className="transcript-container" ref={scrollRef}>
          {liveTranscripts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎙️</div>
              <h3>Ready to listen.</h3>
              <p>Start a session to begin real-time translation.</p>
            </div>
          ) : (
            <div className="transcript-paper">
              {liveTranscripts.map((t, idx) => (
                <div 
                  key={t.id || idx} 
                  className={`transcript-line ${!t.final ? 'partial' : ''}`}
                >
                  {t.text}
                </div>
              ))}
            </div>
          )}
        </main>

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
