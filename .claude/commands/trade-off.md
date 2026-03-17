Generate a deep technology trade-off comparison for the component or technology the user is asking about.

## Output Format

Create a file at `components/<topic>.md` with the following structure:

### 1. Comprehensive Comparison Matrix
A markdown table comparing all relevant options across these dimensions:
- Throughput
- Latency (p50, p99)
- Persistence / Durability
- Consistency model
- Routing / Flexibility
- Ordering guarantees
- Scaling model
- Operational complexity
- Cost model
- Use cases

### 2. Underlying Implementation Differences
For each technology, explain the core mechanism that drives its behavior:
- What data structure does it use internally?
- What is the I/O model (push vs pull, sequential vs random)?
- How does replication/consistency work?
- Where are the performance bottlenecks?

Include ASCII diagrams where helpful.

### 3. Architect's Decision Tree
A flowchart-style decision tree (using text/markdown) that guides the reader to the right choice based on their requirements. Use concrete conditions, not vague advice.

### 4. Common Pitfalls
List 3-5 common mistakes engineers make when choosing between these options.

## Capacity Planning Anchors
Include concrete numbers for each technology (e.g., "1 Kafka partition sustains ~10 MB/s write throughput") so the reader can do back-of-the-envelope calculations.

## Rules
- Use Traditional Chinese for prose, keep technical terms in English.
- Ground every claim in a mechanism or number.
- "It depends" must always be followed by "on what exactly".
