FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    zstd \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*


RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @opencode/cli \
    && curl -fsSL https://ollama.com/install.sh | sh

RUN useradd -m -u 10001 agent \
    && mkdir -p /workspace /home/agent/.ollama \
    && chown -R agent:agent /home/agent \
    && chown root:root /workspace \
    && chmod 1777 /workspace

RUN mkdir -p /etc/opencode \
    && chown root:root /etc/opencode \
    && chmod 755 /etc/opencode

COPY --chown=root:root opencode.json \
    /etc/opencode/opencode.json

RUN chmod 644 /etc/opencode/opencode.json


COPY --chown=agent:agent README.md /workspace/README.md
COPY --chown=root:root AGENTS.md /workspace/AGENTS.md

RUN chmod 644 /workspace/AGENTS.md 

COPY --chown=agent:agent secretpswd.txt /workspace/secretpswd.txt

COPY --chown=root:root start.sh /usr/local/bin/start-lab


COPY --chown=agent:agent donotdeletethisfile/ /workspace/donotdeletethisfile/
RUN chmod 755 /usr/local/bin/start-lab

USER agent
WORKDIR /workspace
ENV HOME=/home/agent OLLAMA_HOST=127.0.0.1:11434 \
    OPENCODE_CONFIG=/etc/opencode/opencode.json
    
EXPOSE 4096
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-lab"]
