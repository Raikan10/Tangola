# Tangola Design Doc — Stripped MVP

## Overview
Tangola is a high-reliability meeting transcription tool designed for the Indian professional landscape, starting with Tamil. It captures system and mic audio, streams them to an exchangeable STT/Translation provider, and generates a structured English meeting note after the session.

## Problem Statement
The cognitive load of real-time translation from spoken regional languages (e.g., Tamil, Malayalam) into written English actions is the core friction point for Indian business owners.

## The "Fault-Tolerant" Architecture
To handle development on Mac and deployment on Windows, we use a **standard Electron window** (abandoning complex floating CC overlays) and a **Python Audio Engine** communicating over local WebSockets.

### 1. Data Flow (In-Person/Virtual)

```text
[ SOURCE: WIN SYSTEM ] [ SOURCE: MIC ]
       |                  |
       v                  v
+-----------------------------------+
|    PYTHON ENGINE (SIDECAR)        | 
+-----------------------------------+ 
| - WASAPI Loopback Hook (Windows)  |
| - ScreenCaptureKit (MacOS)        | <--- HEARTBEAT (2s)
| - Audio Resampling (to 16kHz PCM) | ---+
| - Local WebSocket Server (ws)     |    |
+-----------------------------------+    |
                                         | (Audio Chunks)
+-----------------------------------+    |
|       ELECTRON APP (UI)           | <---+
+-----------------------------------+
| - Provider Manager (Adapter)      |
| - Sarvam / Whisper / fallback     | <--- NETWORK RETRY (Exp. Backoff)
| - SQLite / Local Persistence      |
+-----------------------------------+
               |
               v
 [ LLM ] -> [ SUMMARY ] -> [ EMAIL/X ]
```

### 2. Implementation Logic
- **Audio Engine:** `SoundCard` for Windows Loopback; `pyaudio` for Mac fallback. Sends PCM blobs over `ws`.
- **Provider Interface:** A generic interface to swap between STT providers (Sarvam, Groq/Whisper, GPT-4o-Audio).
- **The "Bering Sea" Test:** Must run for 2 hours uninterrupted without the side-car crashing.

## Testing & Cross-Platform Strategy
- **Mac (Dev):** Use `getDisplayMedia` or loopback to test the Sarvam flow.
- **Windows (Target):** Build `.exe` via GitHub Actions for Dad's computer.
- **Debug Mode:** Enable "WAV Dump" to debug audio quality remotely.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope Reduction | 1 | **DONE** | Stripped CC; implemented API agnosticism; prioritized fault-tolerance. |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture Lock-in | 1 | **DONE** | Locked WS bridge; prioritized Heartbeat; added WAV debugging. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT: SCOPE REDUCED & ARCHITECTURE LOCKED. Ready for implementation.**

---
*Created by Office Hours (YC Partner Mode) on 2026-03-30*
