# OpenCode Dev

[![Release](https://img.shields.io/github/v/release/y93v/opencode-dev?color=blue&label=Latest%20Release)](https://github.com/y93v/opencode-dev/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](https://github.com/y93v/opencode-dev/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An enhanced, high-performance desktop development environment built on **OpenCode v2.3.2**. Designed for developers who require intelligent model orchestration, seamless rate-limit resiliency, and a clean, focused user interface.

---

## 📥 Download & Quick Start

Pre-built Windows desktop installers are available directly from GitHub Releases:

👉 **[Download OpenCode Dev v2.3.2 (.exe)](https://github.com/y93v/opencode-dev/releases/latest)**

1. Download and run `OpenCode-v2.3.2-Setup.exe`.
2. Launch **OpenCode Dev** from your Start Menu or Desktop shortcut.
3. Access advanced features and controls directly from the composer toolbar.

---

## ✨ Key Features

- **Intelligent Prompt Orchestration (Auto JB):**
  - Advanced prompt routing tailored for leading model architectures (DeepSeek, GLM, Beam, HY4, MIMO, Big Pickle).
  - One-click toggle switch integrated directly into the composer toolbar.
  - Zero session restart required: smoothly transition between tuned and standard modes.

- **Automated Fallback & Limit Resilience:**
  - Dynamic failover handling that seamlessly routes requests when upstream model limits are reached.
  - Full compaction protection to safeguard long conversations, system prompts, and project context.

- **Streamlined Desktop Interface:**
  - Modern, distraction-free **Dev** theme built for productivity.
  - Native Windows desktop integration with high DPI scaling and fluid animations.
  - Dedicated agent workspaces with optimized `Build` and `Plan` modes.

- **Session Management:**
  - Instant client fingerprint rotation to refresh sessions on demand while preserving your chats and workspace history.

---

## 🛠️ Building from Source

To build the CLI, Desktop application, and the Windows installer locally:

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+) or [Bun](https://bun.sh/)
- PowerShell 7+

### Build
```powershell
# Clone the repository
git clone https://github.com/y93v/opencode-dev.git
cd opencode-dev

# Run automated one-step build
.\build.ps1
```

The compiled installer will be saved to `release/OpenCode-Setup.exe`.

---

## 🔄 Upstream Synchronization

Keep your local build in sync with upstream updates:

```powershell
.\update.ps1
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE). Upstream components remain copyright of their respective authors.
