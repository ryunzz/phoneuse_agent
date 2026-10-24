# Cal Hacks 13.0 sponsors and prize plan

Source: [cal-hacks-13-0.devpost.com](https://cal-hacks-13-0.devpost.com/), pulled 2026-10-24. The prize list in older notes came from Cal Hacks 12.0 (2025) and is obsolete. LiveKit, Baseten, Groq, Lava, Reka, Letta, Chroma, Vapi, Wordware and BitRobot are **not** sponsors this year.

## Rules that matter

- **Submit by Sun Oct 25, 9:00 AM PST (hard deadline).** Be at the venue by 8:00 AM, checked in as hackers.
- The submission needs a project image, the GitHub repo, and a pre-recorded or live demo. Sponsors judge asynchronously from the Devpost video.
- Pitch: 3 minutes plus 2 minutes of Q&A.
- **No cap on sponsor tracks** (confirmed by the team). Enter every track that fits the phone-use theme.
- Judging criteria: Application, Intentionality, Functionality, Creativity, Technical Complexity.
- Honesty constraint ([HARNESS_LIMITATIONS.md](../HARNESS_LIMITATIONS.md)): until the stylus path is verified on hardware, describe phone control as Mirroring-dependent and operator-mediated. This applies to the hardware tracks too.

## Integration principle

Every sponsor integration is an **adapter behind an interface**, chosen by env (`<CAPABILITY>_PROVIDER=<vendor>` plus that vendor's key). Swapping vendors to chase a track means adding one file and changing env, not touching the core. Capabilities: Payments, VLM (`VLM_PROVIDER`), Grounding/Vision model, Voice, Usage/Trace store, Agent wrapper.

## Track map

**Fit:** ✅ enter (fits now or with a small integration) · 🎬 enter, but it depends on the demo we choose · 🧪 possible with a real integration, so decide by time · ❌ off theme.

### Cal Hacks overall

| Track | Prize | Fit | Our angle |
| --- | --- | --- | --- |
| First / Second / Third Overall | $3,600 + laptops / Switch 2 / Google eyewear | ✅ | Cloud phones for any AI agent: hosted MCP, token billing, live view, VLM data flywheel |
| Most Technically Complex | NuPhy Air60 HE | ✅ | Gateway, rig long-poll, metering, trace pipeline, review UI, Swift capture/action, (stylus) |
| Most Creative | Instax | ✅ | "Computer use for any screen": a robot finger on a real phone |
| Best Hardware Hack | Bambu Lab 3D printer each | ✅ (once the stylus is verified) | Printer-turned-stylus rig. Only claim what we demo physically. |
| Best People-First Social Impact | Apple Watch SE 3 | ✅ | Phones for people who can't use them: grandma, accessibility, benefits portals |
| Hacker's Choice | MX Master 4 | ✅ | A live robot demo at the table |
| Beginner / Solo / Planet-First | — | ❌ | — |

### Sponsor tracks

| Sponsor · track | Prize | Fit | What we build / show | Owner |
| --- | --- | --- | --- | --- |
| **Anthropic** · Claude for Public Benefit | $5k Claude credits + Max 20x | ✅ | Claude operates real phones for people locked out of apps-only services | Ryan |
| **Coinbase** · Best Use of x402 (2 tracks) | $500 USDC + recruiter call per member per track | ✅ | `PAYMENTS_PROVIDER=x402`: agents pay per tool call in USDC (HTTP 402) for cloud-phone tokens. Ask Coinbase what the two tracks are. | Ryan |
| **Fetch.ai** · Best Use of Fetch.ai | $1.5k / $1k / $500 | ✅ | Register a phone-use agent on Agentverse (Chat Protocol) that calls our gateway | Ryan |
| **Atlassian** · Best Agent / Best Security Solution for Agents | AirPods Max | ✅ | Best Agent: the phone agent. Security: key-scoped leases, recorded and reviewed actions. Name the track in the description. | Ryan |
| **Microsoft** · Built for the Real World / Customer Impact | Surface laptops + FDE talk | ✅ | Real phones and real apps, where APIs don't exist | Ryan |
| **MLH** · Best Use of Vultr | M5Stack Tab5 | ❌ | Dropped: the user doesn't need hosting. The gateway runs on the rig Mac behind a free `cloudflared` tunnel. | — |
| **MLH** · Best Domain (GoDaddy Registry) | Gift card | 🧪 | Optional: a domain in front of the tunnel | Ryan |
| **MLH** · Best Use of Gemini API | Swag | ✅ | `GROUNDING_PROVIDER=gemini`: `phone_find("Settings icon")` → (x, y) | Ryan |
| **MLH** · Commit Fellowship | Interview + mentorship | ✅ | Startup angle. Opt in at submission **and** fill in the supplemental form. | Ryan |
| **Meta** · Bringing People Closer Together with AI | Round 2 at Menlo Park | 🎬 | Demo: agent helps grandma video-call or message family on her phone | Ryan |
| **Hyphenate** · Autonomous Systems for Finance | $8k / $5k / $3k | 🎬 | Demo: agent completes a finance task that only exists in a phone app (chargeback dispute, expense upload). Hyphenate does autonomous finance (formerly Maximor). | Ryan |
| **Visa** · Reimagining Shopping | $5k | 🎬 | Demo: agent buys or returns through a mobile-only shopping app | Ryan |
| **Capital One** · Best Use of Nessie | $300/person | 🎬 | "API when one exists, phone when not": Nessie for banking data, phone for the rest | Ryan |
| **Cartesia** · Best Use of Cartesia | ~$1.5k | 🧪 | `VOICE_PROVIDER=cartesia`: voice mode plus an `ask_user` call for 2FA codes | Ryan |
| **Convex** · Best use of Convex | $5k | 🧪 | `STORE_PROVIDER=convex`: live usage/trace state with live queries for the dashboard and review | Ryan |
| **Tiger Data** (MLH) | Stream Deck Mini | 🧪 | Usage ledger as time-series (tokens/minute) in Tiger Data | Ryan |
| **Apify** · Best Use / Best Actor | $2k… / $400 | 🧪 | An Apify Actor that runs a phone task through our gateway | Ryan |
| **Factory** · Droid SDK | $2k | 🧪 | Drive our MCP from a Factory Droid | Ryan |
| **Spacetime** · Best Use | $2,048 / $1,024 / $512 | 🧪 | Real-time rig/lease state in SpacetimeDB | Ryan |
| **Bitdeer AI** · Model Studio | Credits + mice | 🧪 | Host the grounding model there (a grounding adapter) | Ryan |
| **Coinbase/ETH** payouts (TestFlight) | — | ✅ | Nikhil: humans paid in ETH for task demonstrations, which feed the same episode format | Nikhil |
| Mana ($5k), Moss, CRS ($2k/$1k) | — | ❓ | Nothing found online. Ask at the booths whether a phone-agent project qualifies. | — |
| Snowflake, Solana, Elastic, Bright Data, Figma, Notability, Armadin, SpaceXSI | — | ❌ | Off theme (or needs a stack we don't use) | — |

## Priority tonight (deadline 9 AM)

1. **Core demo works end to end** on the real phone via Mirroring, plus the stylus if the hardware lands. Record the video early.
2. **x402 payments adapter** (Coinbase ×2 tracks, and the business model).
3. **Public URL via `cloudflared tunnel --url http://localhost:8787`** (no hosting needed).
4. **Gemini grounding adapter** (`phone_find`).
5. **Fetch.ai Agentverse wrapper.**
6. Demo-choice tracks (Hyphenate / Visa / Meta / Capital One): pick one demo task that hits the most of them and say so in the write-up.
7. 🧪 tracks only if time remains.
