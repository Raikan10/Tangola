# Tangola Roadmap

- [ ] **Phase 1: Audio Foundation**
    - [ ] Create `engine/` adapter for Windows (WASAPI) and Mac (Microphone).
    - [ ] Implement Local WebSocket server in Python to stream audio.
    - [ ] Add 2s Heartbeat between Python and Electron.

- [x] **Phase 2: The Provider Plugin**
    - [x] Define generic `STTProvider` interface.
    - [x] Implement `SarvamProvider` (Tamil -> English).
    - [x] Implement `OpenAIProvider` (as a reliable fallback).

- [x] **Phase 3: Simplified UI**
    - [x] Standard Electron window (Main Dashboard).
    - [x] Real-time Transcript display panel.
    - [x] "Record" state management.

- [x] **Phase 4: Summarization & Context**
    - [x] JSON transcript persistence.
    - [x] LLM prompt engineering for "Granola-style" structured notes.
    - [x] Basic "WAV Debug" toggle for remote troubleshooting.


- [ ] **Phase 5: Production Infrastructure**
    - [ ] **Authentication:** Integrate Supabase/Firebase for user accounts (Google & Email).
    - [ ] **Secure API Proxy:** Move API keys to a backend server to prevent client-side extraction.
    - [ ] **Cloud Sync:** Sync transcripts to a cloud database for cross-device access.
    - [ ] **Analytics:** Integrate **PostHog** for usage tracking and performance monitoring.

- [ ] **Phase 6: Distribution & Monetization**
    - [ ] **Payments:** Integrate **Razorpay** for UPI/QR payments (optimized for India).
    - [ ] **Advanced Features:** Implement Speaker Identification (Who is speaking?).
    - [ ] **Auto-Updates:** Set up Electron-Updater for automated app versions.
    - [ ] **Notarization:** Automate Apple Notarization and Windows Signing in CI/CD.
    - [ ] **Landing Page:** Simple site to download the `.dmg` and `.exe`.

---

### Progress & Notes:
- **Phases 1-4:** Core engine and UI are functional on Mac.
- **Standalone:** Python bundling is implemented and signable.
- **Priority:** Speaker detection and improved meeting summary prompts.
- **Market:** Optimized for Tamil/English mixed meetings in India.

Before committing this file, please check the previous version to see if anything's been missed out. Also, the build still doesn't work; the docs don't say anything. I only know the mic is working; mic permissions are not being gotten. I don't know what that even looks like. A lot of things to work on, but at least the dev version works fine. 

The app works. I was fucking up because the notary stuff and other stuff, but it finally works now I'm able to generate a DMG and make it work. The next step is to definitely notarize it, and then to figure out the same thing all over again for Windows. So vamos. 