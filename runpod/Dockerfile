ARG VERSION=server-cuda
FROM fishaudio/fish-speech:${VERSION}

USER root
WORKDIR /app

# 1. Install curl AND python3-venv (which is required by the HF CLI installer)
RUN apt-get update && apt-get install -y curl python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    /app/.venv/bin/python3 -m ensurepip --upgrade && \
    /app/.venv/bin/python3 -m pip install --no-cache-dir runpod && \
    curl -LsSf https://hf.co/cli/install.sh | bash
    
# 2. Add the HF CLI binary to your PATH
ENV PATH="/root/.local/bin:${PATH}"

# 3. Download the model 
RUN hf download fishaudio/s2-pro \
    --local-dir /app/checkpoints/s2-pro

# 4. Copy your local files
COPY ./src /app/src
RUN chmod +x /app/src/run.sh

# 5. Environment setup
ENV PYTHONPATH="/app:/app/src"

ENTRYPOINT ["/app/src/run.sh"]
