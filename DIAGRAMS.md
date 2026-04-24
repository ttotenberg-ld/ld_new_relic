# LaunchDarkly + New Relic Integration Diagrams

## Decision Flowchart

```mermaid
flowchart TD
    Start[Customer wants LD + NR integration] --> Q0{Has NR Control / PCG deployed?}

    Q0 -->|Yes| E1[Option E: PCG dual-export]
    Q0 -->|No| Q1{Using OTel SDK?}

    Q1 -->|Yes| A1[Approach 1: OTel SDK + LD TracingHook]
    Q1 -->|No| Q2{Willing to adopt OTel?}

    Q2 -->|Yes| A1
    Q2 -->|No| Q3{Has NR Data Plus?}

    Q3 -->|Yes| B1[Option B: NR Streaming Export → LD]
    Q3 -->|No| B2[Option C: NerdGraph Polling → LD]

    A1 --> R1{Want traces in LD for Guarded Rollouts?}
    R1 -->|Yes| C1[Add OTel Collector dual-export]
    R1 -->|No| Done1[Done - flags visible in NR]

    C1 --> Done2[Done - flags in NR + telemetry in LD]
    B1 --> Done3[Done - telemetry in LD via NR export]
    B2 --> Done4[Done - telemetry in LD via polling]
    E1 --> Done5[Done - PCG forks to NR + LD]
```

## Option A: OTel Collector Dual-Export

```mermaid
flowchart LR
    subgraph App["Application"]
        SDK[LD Server SDK]
        Hook[TracingHook]
        OTel[OTel SDK]
        SDK --> Hook --> OTel
    end

    OTel -->|OTLP| Collector[OTel Collector]

    subgraph Collector["OTel Collector"]
        Recv[OTLP Receiver]
        Recv --> P1[Pipeline 1: batch]
        Recv --> P2[Pipeline 2: filter spanevents → filter spans → groupbytrace → batch]
    end

    P1 -->|ALL spans| NR[New Relic<br/>otlp.nr-data.net]
    P2 -->|Guarded rollout spans only| LD[LaunchDarkly<br/>otel.observability.app.launchdarkly.com]
```

## Option B: New Relic Streaming Export

```mermaid
flowchart LR
    subgraph App["Application"]
        Agent[NR APM Agent]
        SDK[LD Server SDK]
        Hook[NR Agent Hook]
        SDK --> Hook --> Agent
    end

    Agent -->|Traces| NR[New Relic]

    NR -->|Streaming Export<br/>WHERE feature_flag.key IS NOT NULL| Bus[Cloud Message Bus<br/>Kinesis / Event Hub / Pub/Sub]

    Bus --> Fn[Transform Function<br/>NR JSON → OTLP]

    Fn -->|OTLP| LD[LaunchDarkly]
```

## Option E: Pipeline Control Gateway (PCG)

```mermaid
flowchart LR
    subgraph AppA["App A (NR Agent)"]
        Agent[NR APM Agent]
        SDK1[LD Server SDK]
        Hook1[TracingHook via OTel API]
        SDK1 --> Hook1 --> Agent
    end

    subgraph AppB["App B (OTel SDK)"]
        OTel[OTel SDK]
        SDK2[LD Server SDK]
        Hook2[TracingHook]
        SDK2 --> Hook2 --> OTel
    end

    Agent -->|NR agent protocol| PCG
    OTel -->|OTLP| PCG

    subgraph PCG["Pipeline Control Gateway (OTel Collector in customer K8s)"]
        RcvNR[newrelic receiver]
        RcvOTLP[otlp receiver]
        P1[Pipeline 1: batch]
        P2[Pipeline 2: filter spanevents → filter spans → groupbytrace → batch]
        RcvNR --> P1
        RcvNR --> P2
        RcvOTLP --> P1
        RcvOTLP --> P2
    end

    P1 -->|ALL telemetry| NR[New Relic Cloud]
    P2 -->|Guarded rollout spans only| LD[LaunchDarkly<br/>otel.observability.app.launchdarkly.com]
```

## Option D: LD New Relic Ingest Service

```mermaid
flowchart LR
    subgraph App["Application"]
        Agent[NR APM Agent]
        SDK[LD Server SDK]
        Hook[NR Agent Hook]
        SDK --> Hook --> Agent
    end

    Agent -->|Traces| NR[New Relic]

    subgraph LD["LaunchDarkly"]
        Ingest[NR Ingest Service]
        GR[Guarded Rollouts]
        Ingest --> GR
    end

    NR <-->|NerdGraph API<br/>or Streaming Export| Ingest
```

## Volume Comparison

```mermaid
flowchart TD
    subgraph Input["App Output"]
        Total["100,000 spans/min"]
    end

    subgraph Collector["OTel Collector"]
        Filter["2-stage filter:<br/>1. Keep only inExperiment flag events + exceptions<br/>2. Keep spans with http.route or surviving events"]
    end

    Total --> NR["New Relic<br/>100,000 spans/min<br/>(full fidelity)"]
    Total --> Filter
    Filter --> LD["LaunchDarkly<br/>Only active guarded rollout traces"]

    style LD fill:#2f6,stroke:#333
    style NR fill:#26f,stroke:#333
```

## End-to-End: Guarded Rollout with New Relic

```mermaid
sequenceDiagram
    participant App as Application
    participant LD_SDK as LD SDK
    participant OTel as OTel SDK
    participant Coll as OTel Collector
    participant NR as New Relic
    participant LD as LaunchDarkly

    App->>LD_SDK: variation("new-checkout", user)
    LD_SDK->>LD_SDK: Evaluate flag → variation 1
    LD_SDK->>OTel: TracingHook adds span event<br/>(feature_flag.key, context.key, inExperiment=true)
    App->>App: Handle request (may error/be slow)
    App->>OTel: Span completes with HTTP attributes
    OTel->>Coll: Export span via OTLP

    par Full fidelity to NR
        Coll->>NR: All spans
    and Filtered to LD
        Coll->>Coll: filter spanevents (inExperiment only)<br/>filter spans (http.route or events)<br/>groupbytrace (10s wait)
        Coll->>LD: Guarded rollout traces only
    end

    LD->>LD: Correlate: variation 1 has 12% error rate<br/>vs variation 0 baseline of 2%
    LD->>LD_SDK: Automated rollback!<br/>(disable variation 1)

    Note over NR: Customer can also see<br/>flag impact in NR dashboards
```
