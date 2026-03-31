# Tangola Design Doc — Stripped MVP

## Overview
Tangola is a high-reliability meeting transcription tool designed for the Indian professional landscape, starting with Tamil. It captures system and mic audio, streams them to an exchangeable STT/Translation provider, and generates a structured English meeting note after the session.

## Problem Statement
The cognitive load of real-time translation from spoken regional languages (e.g., Tamil, Malayalam) into written English actions is the core friction point for Indian business owners.

## The "Fault-Tolerant" Architecture
To handle development on Mac and deployment on Windows, we use a **standard Electron window** (abandoning complex floating CC overlays). Initially designed with a Python Audio Engine, we've now directly integrated the official `sarvamai` JS SDK into the Electron Main Process, managing translation streaming directly in Node.js.

### 1. Data Flow (In-Person/Virtual)

```text
[ SOURCE: WIN SYSTEM ] [ SOURCE: MIC ]
       |                  |
       v                  v
+-----------------------------------+
|       ELECTRON APP (MAIN)         |
+-----------------------------------+
| - Provider Manager (Adapter)      |
| - Sarvam JS SDK Streaming         | <--- DIRECT AUDIO PIPELINE
| - JSON / Local Persistence        |
+-----------------------------------+
               |
               v
+-----------------------------------+
|       ELECTRON APP (UI)           |
+-----------------------------------+
| - Master-Detail (Past Meetings)   |
| - Realtime Transcript UI          |
+-----------------------------------+
               |
               v
 [ LLM ] -> [ SUMMARY ] -> [ EMAIL/X ]
```

### 2. Implementation Logic
- **Audio Engine:** Handled via JavaScript direct browser/system media capture routing into the `sarvamai` Node streaming client.
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
