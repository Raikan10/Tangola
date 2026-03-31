# Tangola Roadmap

- [ ] **Phase 1: Audio Foundation**
    - [ ] Create `engine/` adapter for Windows (WASAPI) and Mac (Microphone).
    - [ ] Implement Local WebSocket server in Python to stream audio.
    - [ ] Add 2s Heartbeat between Python and Electron.

- [x] **Phase 2: The Provider Plugin**
    - [x] Define generic `STTProvider` interface.
    - [x] Implement `SarvamProvider` (Tamil -> English).
    - [ ] Implement `OpenAIProvider` (as a reliable fallback).

- [x] **Phase 3: Simplified UI**
    - [x] Standard Electron window (Main Dashboard).
    - [x] Real-time Transcript display panel.
    - [x] "Record" state management.

- [ ] **Phase 4: Summarization & Context**
    - [/] JSON transcript persistence.
    - [ ] LLM prompt engineering for "Granola-style" structured notes.
    - [ ] Basic "WAV Debug" toggle for remote troubleshooting.


Phase two and three seem to be working very well. Our phase one does not seem to be implemented, so let's check that. Phase four looks interesting, so we can definitely try that out. All of it looks very good right now. I've committed everything. Come back and try to see how to make this work and take this to Windows also and get my dad to check it out. 

try builds of other APIs too; OpenAI, Deepgram, AssemblyAI, etc. 