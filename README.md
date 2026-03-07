# VRM Fleet Dashboard

Real-time fleet monitoring for Victron Energy solar systems and Pepwave cellular routers with AI-powered natural language queries.

![Dashboard Preview](https://img.shields.io/badge/status-active-success)
![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![React](https://img.shields.io/badge/react-18-blue)
![PostgreSQL](https://img.shields.io/badge/postgresql-16-blue)

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Start development server
npm run dev
```

Open http://localhost:5173

## ✨ Features

- 📊 **Real-time monitoring** - Battery SOC, solar power, DC load, network status
- 🎯 **Tech Status** - 3-state system (Good/Watch/Needs Attention) for field techs
- 🤖 **AI queries** - Ask questions in plain English: "Which trailers are offline?"
- 📡 **Network analytics** - Signal strength, data usage, carrier tracking
- ⚡ **Energy alerts** - Automatic deficit detection with SOC trend analysis
- 📈 **Historical charts** - Battery trends, DC load, usage patterns
- 🔧 **Diagnostics** - VRM alarm/error tracking, MPPT state, inverter mode

## 📚 Documentation

**[Complete Documentation →](Documents/README.md)**

Detailed guides covering:
- Setup and installation
- API configuration
- Usage examples
- API endpoints
- Database schema
- Troubleshooting

## 🔑 Required API Keys

- **Victron VRM API** - Solar system monitoring
- **Pepwave InControl2** - Network device tracking
- **Anthropic Claude** - Natural language queries

See [Documentation](Documents/README.md) for credential setup instructions.

## 🛠️ Tech Stack

**Frontend:** React + Vite + Chart.js
**Backend:** Node.js + Express + PostgreSQL
**AI:** Claude 4.5 Sonnet for natural language to SQL

## 📝 Example Queries

```
"How much data have we used?"
"Which trailers have low battery?"
"Show me signal strength by carrier"
"What's the average SOC across the fleet?"
```

## 🤝 Contributing

Internal project for Antigravity Inc.

## 📄 License

Proprietary

---

Built with [Claude Code](https://claude.com/claude-code)
