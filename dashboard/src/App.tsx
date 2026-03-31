import { useEffect, useState, useRef } from 'react'

declare global {
  interface Window {
    electronAPI: any;
  }
}

function App() {
  const [engineStatus, setEngineStatus] = useState('Disconnected');
  const [providerStatus, setProviderStatus] = useState('Disconnected');
  const [isRecording, setIsRecording] = useState(false);
  const [transcripts, setTranscripts] = useState<{id: number, text: string, final: boolean}[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    // Poll status initially
    window.electronAPI.getStatus().then((status: any) => {
      setEngineStatus(status.pythonConnected ? 'Connected' : 'Disconnected');
      setIsRecording(status.recording);
    });

    const onEngineStatus = (_event: any, status: string) => setEngineStatus(status);
    const onProviderStatus = (_event: any, status: string) => setProviderStatus(status);
    
    const onTranscript = (_event: any, { text, isFinal }: { text: string, isFinal: boolean }) => {
      setTranscripts(prev => {
        const last = prev[prev.length - 1];
        if (last && !last.final) {
          // Update the partial line
          const newArr = [...prev];
          newArr[newArr.length - 1] = { ...last, text, final: isFinal };
          return newArr;
        } else {
          // Create new line
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

  const handleStart = async () => {
    if (!isRecording) {
      const success = await window.electronAPI.startCapture();
      if (success) {
        setIsRecording(true);
      }
    }
  };

  const handleStop = async () => {
    if (isRecording) {
      const success = await window.electronAPI.stopCapture();
      if (success) {
        setIsRecording(false);
      }
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '600px', margin: '0 auto' }}>
      <h1>Tangola (Sarvam STT)</h1>
      
      <div style={{ padding: '10px', background: '#f5f5f5', borderRadius: '8px', marginBottom: '20px' }}>
        <div><strong>Engine:</strong> {engineStatus}</div>
        <div><strong>Sarvam API:</strong> {providerStatus}</div>
      </div>
      
      <div style={{ marginBottom: '20px' }}>
        <button 
          onClick={isRecording ? handleStop : handleStart}
          style={{ 
            padding: '12px 24px', 
            fontSize: '16px', 
            background: isRecording ? '#ff4d4d' : '#4caf50',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
        >
          {isRecording ? 'Stop Meeting' : 'Start Meeting'}
        </button>
      </div>

      <div style={{ 
        height: '300px', 
        overflowY: 'auto', 
        border: '1px solid #ccc', 
        padding: '10px', 
        borderRadius: '8px',
        background: '#fff'
      }}>
        {transcripts.length === 0 && <span style={{ color: '#999' }}>Meeting context will appear here...</span>}
        {transcripts.map(t => (
          <div key={t.id} style={{ 
            marginBottom: '8px', 
            color: t.final ? '#000' : '#888',
            transition: 'color 0.2s'
          }}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
