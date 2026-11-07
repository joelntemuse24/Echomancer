# Sowell CPU image. Official Python, not Debian apt python, so later
# `python -m pip` layers are not blocked by PEP 668. Do not apt-install
# python3. Do not query pip's config. The voice pack is a build input
# and is not part of the Next.js bundle.
#
#   docker build -f workers/sowell/Dockerfile .
# Place voices/sowell/am_sowell_avg.pt (gitignored) before building.
# The pack check fails the image if the hash or layout is wrong.

FROM python:3.11-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    espeak-ng \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/sowell/requirements.txt /tmp/sowell-requirements.txt
RUN pip install --no-cache-dir -r /tmp/sowell-requirements.txt \
  && python -c "import kokoro, torch; assert torch.__version__"

COPY scripts/sowell /opt/sowell/scripts
COPY voices/sowell/manifest.json /opt/sowell/voices/manifest.json
COPY voices/sowell/am_sowell_avg.pt /opt/sowell/voices/am_sowell_avg.pt

ENV SOWELL_PACK=/opt/sowell/voices/am_sowell_avg.pt
ENV SOWELL_MANIFEST=/opt/sowell/voices/manifest.json
ENV SOWELL_CPU_THREADS=2
ENV OMP_NUM_THREADS=2
ENV OPENBLAS_NUM_THREADS=2
ENV MKL_NUM_THREADS=2
ENV HF_HOME=/opt/hf
ENV PYTHONPATH=/opt/sowell/scripts

RUN python /opt/sowell/scripts/pack_main.py

WORKDIR /opt/sowell/scripts
CMD ["python", "synthesize.py", "--help"]
