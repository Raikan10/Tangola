# Tangola Design System

## 1. Vision: "Obsidian Focus"
Tangola is a high-reliability meeting assistant that stays out of the way. The design language is **Dark, Focused, and Precise**. We use a charcoal color palette with glassmorphic layers to provide a premium feel during business meetings.

## 2. Brand Identity
- **Logo Style**: 800 Weight Sans-Serif with a green gradient.
- **Tone**: Professional, Reliable, Modern.
- **Metaphor**: A dark room where only the essential text is illuminated.

## 3. Design Tokens (The "Source of Truth")

### Colors
| Token | Value | Use Case |
| :--- | :--- | :--- |
| `bg-color` | `#0b0e14` | Main application background |
| `sidebar-bg` | `#12161f` | Navigation and sidebar |
| `card-bg` | `#1a1f29` | List items and secondary panels |
| `border-color`| `#2d333f` | Dividers and strokes |
| `accent-color`| `#3fb950` | Primary actions (Start Meeting) |
| `danger-color`| `#f85149` | Destructive actions (Stop Meeting) |
| `text-primary`| `#e6edf3` | Headings and transcript text |
| `text-secondary`| `#9198a1` | Metadata and secondary info |

### Typography
| Style | Size | Weight | Font Family |
| :--- | :--- | :--- | :--- |
| **Heading 1** | 24px | 800 | Inter / System Sans |
| **Heading 2** | 20px | 700 | Inter / System Sans |
| **Transcript** | 18px | 400 | Inter / System Sans |
| **Metadata** | 12px | 400 | Inter / System Sans |
| **Labels** | 11px | 600 | Inter / System Sans |

### Spacing & Interactivity
- **Backdrop Blur**: `12px` on fixed headers for glassmorphism.
- **Radius**: `8px` for list items, `100px` for primary "Record" buttons.
- **Transitions**: `0.3s cubic-bezier(0.4, 0, 0.2, 1)` for button states.
- **Animations**: `fadeInSlide 0.4s` for new transcript arrivals.

## 4. Component Rules

### The Sidebar
- Fixed `280px` width.
- Border-right `1px` stroke.
- Meetings sorted by most recent first.

### The Transcript Viewer
- Max content width: `800px` for optimal readability.
- Line height: `1.8` to prevent visual crowding.
- **Partial segments**: Italicized and secondary color (`#9198a1`).
- **Final segments**: Solid and primary color (`#e6edf3`).

## 5. Implementation Status

| Feature | Design Target | Code Status |
| :--- | :--- | :--- |
| Color Pallete | Obsidian Dark | ✅ Implemented |
| Glassmorphism | Blur-12px | ✅ Implemented |
| Typography | Inter UI | ✅ Implemented |
| Transcripts | Fade-in Motion | ✅ Implemented |
| Notifications | Hot Toast Dark | ✅ Implemented |

---
*Maintained by Antigravity Design Consulting — Last Updated 2026-04-01*
