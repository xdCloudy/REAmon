# System Architecture

## High-Level Architecture

```mermaid
flowchart TB
    subgraph User["👤 User Layer"]
        Browser[Web Browser]
        CLI[Terminal/CLI]
    end

    subgraph Frontend["🖥️ Frontend Layer"]
        Webapp[Next.js Webapp<br/>:3000]
    end

    subgraph Backend["⚙️ Backend Layer"]
        Agent[AI Agent Orchestrator<br/>FastAPI + LangGraph<br/>:8090]
        ReconOrch[Recon Orchestrator<br/>FastAPI + Docker SDK<br/>:8010]
    end

    subgraph Tools["🔧 MCP Tools Layer"]
        NetworkRecon[Network Recon Server<br/>Curl + Naabu + Masscan<br/>:8000]
        Nuclei[Nuclei Server<br/>:8002]
        Metasploit[Metasploit Server<br/>:8003]
        Nmap[Nmap Server<br/>:8004]
    end

    subgraph Scanning["🔍 Scanning Layer"]
        Recon[Recon Pipeline<br/>Docker Container]
        GVM[GVM/OpenVAS Scanner<br/>Network Vuln Assessment]
        GHHunt[GitHub Secret Hunter<br/>Credential Scanning]
        TruffleHog[TruffleHog<br/>TruffleHog Secret Scanner - Deep Credential Detection]
    end

    subgraph Data["💾 Data Layer"]
        Neo4j[(Neo4j Graph DB<br/>:7474/:7687)]
        Postgres[(PostgreSQL<br/>Project Settings<br/>:5432)]
    end

    subgraph LLMProviders["🧠 LLM Providers"]
        OpenAI[OpenAI]
        Anthropic[Anthropic]
        LocalLLM[Local Models<br/>Ollama · vLLM · LM Studio]
        OpenRouter[OpenRouter<br/>300+ Models]
        Bedrock[AWS Bedrock]
    end

    subgraph External["🌐 External APIs"]
        GitHubAPI[GitHub API<br/>Repos & Code Search]
    end

    subgraph Targets["🎯 Target Layer"]
        Target[Target Systems]
        GuineaPigs[Guinea Pigs<br/>Test VMs]
    end

    Browser --> Webapp
    CLI --> Recon
    Webapp <-->|WebSocket| Agent
    Webapp -->|REST + SSE| ReconOrch
    Webapp --> Neo4j
    Webapp --> Postgres
    ReconOrch -->|Docker SDK| Recon
    ReconOrch -->|Docker SDK| GVM
    ReconOrch -->|Docker SDK| GHHunt
    ReconOrch -->|Docker SDK| TruffleHog
    Recon -->|Fetch Settings| Webapp
    GHHunt -->|GitHub API| GitHubAPI
    TruffleHog -->|GitHub API| GitHubAPI
    Agent -->|API| OpenAI
    Agent -->|API| Anthropic
    Agent -->|API| LocalLLM
    Agent -->|API| OpenRouter
    Agent -->|API| Bedrock
    Agent --> Neo4j
    Agent -->|MCP Protocol| NetworkRecon
    Agent -->|MCP Protocol| Nuclei
    Agent -->|MCP Protocol| Metasploit
    Agent -->|MCP Protocol| Nmap
    Recon --> Neo4j
    GVM -->|Reads Recon Output| Recon
    GVM --> Neo4j
    GVM --> Target
    GVM --> GuineaPigs
    NetworkRecon --> Target
    Nuclei --> Target
    Metasploit --> Target
    Nmap --> Target
    NetworkRecon --> GuineaPigs
    Nuclei --> GuineaPigs
    Metasploit --> GuineaPigs
    Nmap --> GuineaPigs
```

## Data Flow Pipeline

```mermaid
flowchart TB
    subgraph Phase1["Phase 1: Reconnaissance"]
        Domain[🌐 Domain] --> Subdomains[📋 Subdomains<br/>crt.sh, HackerTarget, Subfinder, Knockpy]
        Subdomains --> DNS[🔍 DNS Resolution]
        DNS --> Ports[🔌 Port Scan<br/>Naabu]
        Ports --> HTTP[🌍 HTTP Probe<br/>Httpx]
        HTTP --> Tech[🔧 Tech Detection<br/>Wappalyzer]
        Tech --> Resources[🕸️ Resource Enum<br/>Katana, Hakrawler, GAU, ParamSpider,<br/>Kiterunner, jsluice, FFuf, Arjun]
        Resources --> Vulns[⚠️ Vuln Scan<br/>Nuclei]
    end

    subgraph Phase2["Phase 2: Data Storage"]
        Vulns --> JSON[(JSON Output)]
        JSON --> Graph[(Neo4j Graph)]
    end

    subgraph Phase2b["Phase 2b: Network Vuln Scan (Optional)"]
        JSON -->|IPs + Hostnames| GVM[🛡️ GVM/OpenVAS<br/>170k+ NVTs]
        GVM --> GVMResults[(GVM JSON Output)]
        GVMResults --> Graph
    end

    subgraph Phase2c["Phase 2c: GitHub Secret Hunt (Optional)"]
        JSON -->|Target Domain| GHHunt[🔑 GitHub Secret Hunter<br/>40+ Patterns + Entropy]
        GHHunt --> GHResults[(GitHub Hunt JSON Output)]
        GHResults --> Graph
    end

    subgraph Phase2d["Phase 2d: TruffleHog Secret Scan (Optional)"]
        JSON -->|Target Domain| TruffleHog[🔐 TruffleHog Secret Scanner<br/>Deep Credential Detection]
        TruffleHog --> THResults[(TruffleHog JSON Output)]
        THResults --> Graph
    end

    subgraph Phase3["Phase 3: AI Analysis"]
        Graph --> Agent[🤖 AI Agent]
        Agent --> Query[Natural Language<br/>→ Cypher Query]
        Query --> Graph
    end

    subgraph Phase4["Phase 4: Exploitation"]
        Agent --> MCP[MCP Tools]
        MCP --> NetworkRecon2[Curl + Naabu<br/>HTTP & Port Scan]
        MCP --> Nuclei2[Nuclei<br/>Vuln Verify]
        MCP --> Nmap2[Nmap<br/>Service Detection]
        MCP --> MSF[Metasploit<br/>Exploit]
        MSF --> Shell[🐚 Shell/Meterpreter]
    end

    subgraph Phase5["Phase 5: Post-Exploitation"]
        Shell --> Enum[Enumeration]
        Enum --> Pivot[Lateral Movement]
        Pivot --> Exfil[Data Exfiltration]
    end
```

## Docker Container Architecture

```mermaid
flowchart TB
    subgraph Host["🖥️ Host Machine"]
        subgraph Containers["Docker Containers"]
            subgraph ReconOrchContainer["recon-orchestrator"]
                OrchAPI[FastAPI :8010]
                DockerSDK[Docker SDK]
                SSEStream[SSE Log Streaming]
            end

            subgraph ReconContainer["recon-container"]
                ReconPy[Python Scripts]
                Naabu1[Naabu]
                Httpx[Httpx]
                Subfinder[Subfinder]
                Knockpy[Knockpy]
            end

            subgraph MCPContainer["kali-mcp-sandbox"]
                MCPServers[MCP Servers]
                NetworkReconTool[Network Recon :8000<br/>Curl + Naabu]
                NucleiTool[Nuclei :8002]
                MSFTool[Metasploit :8003]
                NmapTool[Nmap :8004]
            end

            subgraph AgenticContainer["agentic-container"]
                FastAPI[FastAPI :8090]
                LangGraph[LangGraph Engine]
                LLMProvider[LLM Provider<br/>OpenAI · Anthropic · Local · OpenRouter · Bedrock]
            end

            subgraph Neo4jContainer["neo4j-container"]
                Neo4jDB[(Neo4j :7687)]
                Browser[Browser :7474]
            end

            subgraph PostgresContainer["postgres-container"]
                PostgresDB[(PostgreSQL :5432)]
                Prisma[Prisma ORM]
            end

            subgraph WebappContainer["webapp-container"]
                NextJS[Next.js :3000]
                PrismaClient[Prisma Client]
            end

            subgraph GVMStack["GVM Stack (Network Vuln Scanner)"]
                GVMd[gvmd<br/>GVM Daemon]
                OSPD[ospd-openvas<br/>Scanner Engine]
                RedisGVM[redis-gvm<br/>Cache/Queue]
                PgGVM[pg-gvm<br/>GVM Database]
                GVMData[Data Containers<br/>VT + SCAP + CERT + Notus]
            end

            subgraph GVMScanContainer["gvm-scanner-container"]
                GVMScanPy[Python Scripts]
                GVMClient[python-gvm Client]
            end

            subgraph GHHuntContainer["github-secret-hunter-container"]
                GHHuntPy[Python Scripts]
                PyGithub[PyGithub Client]
            end

            subgraph TrufflehogContainer["trufflehog-scanner-container"]
                TrufflehogPy[Python Scripts]
                TrufflehogBin[TruffleHog Binary]
            end

            subgraph GuineaContainer["guinea-pigs"]
                Apache1[Apache 2.4.25<br/>CVE-2017-3167]
                Apache2[Apache 2.4.49<br/>CVE-2021-41773]
            end
        end

        Volumes["📁 Shared Volumes"]
        ReconOrchContainer -->|Manages| ReconContainer
        ReconOrchContainer -->|Manages| GVMScanContainer
        ReconOrchContainer -->|Manages| GHHuntContainer
        ReconOrchContainer -->|Manages| TrufflehogContainer
        GVMScanContainer -->|Unix Socket| GVMd
        GVMd --> OSPD
        GVMd --> PgGVM
        OSPD --> RedisGVM
        GVMData -->|Feed Sync| GVMd
        ReconContainer --> Volumes
        GVMScanContainer -->|Reads Recon Output| Volumes
        Volumes --> Neo4jContainer
        GVMScanContainer --> Neo4jContainer
        WebappContainer --> PostgresContainer
        ReconContainer -->|Fetch Settings| WebappContainer
    end
```

## Exposed Services & Ports

> **Host-exposure policy (since 5.3.1).** Only the webapp (`3000`), the agent
> API (`8090`) and the reverse-shell listener (`4444`) are published on all
> interfaces. Everything else in this table is bound to **`127.0.0.1` only** —
> reachable from the host for debugging, not from the LAN. The MCP servers
> (`8000-8005`) and the MSF/Hydra progress/session endpoints (`8013-8014`)
> require `Authorization: Bearer $MCP_AUTH_TOKEN`;
> the agent supplies it automatically over the internal Docker bridge. See
> [README.MCP.md](README.MCP.md#security-notice) and STRIDE S10/E1/I9/S13.

| Service | URL | Exposure | Description |
|---------|-----|----------|-------------|
| **Webapp** | http://localhost:3000 | LAN | Main UI — create projects, configure targets, launch scans |
| PostgreSQL | 127.0.0.1:5432 | Loopback | Primary database (Prisma) |
| Neo4j Browser | http://127.0.0.1:7474 | Loopback | Graph database UI for attack surface visualization |
| Neo4j Bolt | 127.0.0.1:7687 | Loopback | Neo4j driver protocol (used by agent) |
| Recon Orchestrator | http://127.0.0.1:8010 | Loopback | Manages recon pipeline containers. **Network-isolated:** on its own `redamon-orchestrator-net` (not `redamon`) — reachable from the host and the webapp, but not from the worker. |
| Agent API | http://localhost:8090 | LAN | AI agent WebSocket + REST API |
| MCP Network Recon | http://127.0.0.1:8000/mcp | Loopback + token | Streamable HTTP; curl + naabu (HTTP probing, port scanning) |
| MCP Nuclei | http://127.0.0.1:8002/sse | Loopback + token | Nuclei vulnerability scanner |
| MCP Metasploit | http://127.0.0.1:8003/sse | Loopback + token | Metasploit Framework RPC |
| MCP Nmap | http://127.0.0.1:8004/sse | Loopback + token | Nmap network scanner |
| Metasploit Progress | http://127.0.0.1:8013 | Loopback | Live progress streaming for long-running exploits |
| Tunnel Manager | http://127.0.0.1:8015 | Loopback | ngrok/chisel tunnel configuration API |
| RedAmon Terminal | ws://127.0.0.1:8016 | Loopback | Kali sandbox PTY shell access (xterm.js; browser reaches it via the agent proxy) |
| Metasploit Listener | 0.0.0.0:4444 | LAN (by design) | Reverse shell listener — a target connects back here in direct/no-tunnel mode |

## Recon Pipeline Detail

```mermaid
flowchart TB
    subgraph Input["📥 Input Configuration"]
        Params[project_settings.py<br/>Webapp API → PostgreSQL<br/>TARGET_DOMAIN, SCAN_MODULES]
        Env[.env<br/>Infrastructure Config<br/>Neo4j Credentials]
    end

    subgraph Container["🐳 recon-container (Kali Linux)"]
        Main[main.py<br/>Pipeline Orchestrator]

        subgraph Module1["1️⃣ domain_discovery"]
            WHOIS[whois_recon.py<br/>WHOIS Lookup]
            CRT[crt.sh API<br/>Certificate Transparency]
            HT[HackerTarget API<br/>Subdomain Search]
            SF[Subfinder<br/>50+ Passive Sources]
            Knock[Knockpy<br/>Active Bruteforce]
            DNS[DNS Resolution<br/>A, AAAA, MX, NS, TXT]
        end

        subgraph Module2["2️⃣ port_scan"]
            Naabu[Naabu<br/>SYN/CONNECT Scan<br/>Top 100-1000 Ports]
            Shodan[Shodan InternetDB<br/>Passive Mode]
        end

        subgraph Module3["3️⃣ http_probe"]
            Httpx[Httpx<br/>HTTP/HTTPS Probe]
            Tech[Wappalyzer Rules<br/>Technology Detection]
            Headers[Header Analysis<br/>Security Headers]
            Certs[TLS Certificate<br/>Extraction]
        end

        subgraph Module4["4️⃣ resource_enum"]
            Katana[Katana<br/>Web Crawler]
            Hakrawler[Hakrawler<br/>DOM-aware Crawler]
            ParamSpider[ParamSpider<br/>Passive Param Mining]
            Forms[Form Parser<br/>Input Discovery]
            Endpoints[Endpoint<br/>Classification]
            Jsluice[jsluice<br/>JS URL + Secret Extraction]
        end

        subgraph Module4b["4b️⃣ js_recon"]
            JsPatterns[Secret Detection<br/>100 Regex Patterns]
            JsValidate[Key Validation<br/>21 Service Validators]
            JsSrcMap[Source Map<br/>Discovery]
            JsDepConf[Dependency<br/>Confusion Check]
            JsDomSink[DOM Sink +<br/>Framework Detection]
        end

        subgraph Module5["5️⃣ vuln_scan"]
            Nuclei[Nuclei<br/>9000+ Templates]
            MITRE[add_mitre.py<br/>CWE/CAPEC Enrichment]
        end
    end

    subgraph Output["📤 Output"]
        JSON[(recon/output/<br/>recon_domain.json)]
        Graph[(Neo4j Graph<br/>via neo4j_client.py)]
    end

    Params --> Main
    Env --> Main

    Main --> WHOIS
    WHOIS --> CRT
    CRT --> HT
    HT --> Knock
    Knock --> DNS

    DNS --> Naabu
    Naabu -.-> Shodan

    Naabu --> Httpx
    Httpx --> Tech
    Tech --> Headers
    Headers --> Certs

    Certs --> Katana
    Certs --> Hakrawler
    Katana --> Forms
    Hakrawler --> Forms
    Forms --> Endpoints
    Endpoints --> Jsluice

    Jsluice --> Nuclei
    Nuclei --> MITRE

    MITRE --> JSON
    JSON --> Graph
```

## Agent Workflow (ReAct Pattern)

```mermaid
stateDiagram-v2
    [*] --> Idle: Start
    Idle --> Reasoning: User Message

    Reasoning --> ToolSelection: Analyze Task
    ToolSelection --> AwaitApproval: Dangerous Tool?
    ToolSelection --> ToolExecution: Single Tool
    ToolSelection --> WaveRunner: 2+ Independent Tools

    AwaitApproval --> ToolExecution: User Approves
    AwaitApproval --> Reasoning: User Rejects

    ToolExecution --> Observation: Execute MCP Tool
    Observation --> Reasoning: Analyze Results

    WaveRunner --> WaveRunnerAnalysis: asyncio.gather() All Tools
    WaveRunnerAnalysis --> Reasoning: Combined Analysis

    Reasoning --> Response: Task Complete
    Response --> Idle: Send to User

    Reasoning --> AskQuestion: Need Clarification?
    AskQuestion --> Reasoning: User Response

    state "User Guidance" as Guidance
    Reasoning --> Guidance: User sends guidance
    Guidance --> Reasoning: Injected in next think step

    state "Stopped" as Stopped
    Reasoning --> Stopped: User clicks Stop
    ToolExecution --> Stopped: User clicks Stop
    WaveRunner --> Stopped: User clicks Stop
    Stopped --> Reasoning: User clicks Resume
```

## MCP Tool Integration

```mermaid
sequenceDiagram
    participant User
    participant Agent as AI Agent
    participant MCP as MCP Manager
    participant Tool as Tool Server
    participant Target

    User->>Agent: "Scan ports on 10.0.0.5"
    Agent->>Agent: Reasoning (ReAct)
    Agent->>MCP: Request execute_naabu tool
    MCP->>Tool: JSON-RPC over SSE (:8000)
    Tool->>Target: SYN Packets
    Target-->>Tool: Open Ports
    Tool-->>MCP: JSON Results
    MCP-->>Agent: Parsed Output
    Agent->>Agent: Analyze Results
    Agent-->>User: "Found ports 22, 80, 443..."
```
