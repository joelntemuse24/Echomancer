# Kokoro CPU image for Drew, Walter, and George. Official Python, not Debian
# apt python, so later `python -m pip` layers are not blocked by PEP 668.
# Do not apt-install python3. Do not query pip's config. The voice pack is a
# build input and is not part of the Next.js bundle.
#
#   docker build -f workers/sowell/Dockerfile .
# Place voices/sowell/am_sowell_avg.pt (gitignored) before building.
# The pack check fails the image if the hash or layout is wrong.
#
# Drew's kmodel and pack are NOT baked here: they are private, ~313 MB, and
# come from the `andrew-distill` Modal Volume at runtime. See
# modal/sowell_worker.py and scripts/sowell/drew.py.

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

# Official bm_george at the pinned Kokoro revision. The hash is the file
# from that revision, not a trained pack. A mismatch fails the image.
ENV GEORGE_VOICE=/opt/sowell/voices/bm_george.pt
ENV GEORGE_VOICE_SHA256=f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b
RUN python -c "import hashlib,os,shutil; from pathlib import Path; from huggingface_hub import hf_hub_download; p=Path(hf_hub_download(repo_id='hexgrad/Kokoro-82M', filename='voices/bm_george.pt', revision='f3ff3571791e39611d31c381e3a41a3af07b4987')); d=hashlib.sha256(p.read_bytes()).hexdigest(); assert d==os.environ['GEORGE_VOICE_SHA256'], d; shutil.copy(p, os.environ['GEORGE_VOICE'])"

ENV SOWELL_PACK=/opt/sowell/voices/am_sowell_avg.pt
ENV SOWELL_MANIFEST=/opt/sowell/voices/manifest.json
# Drew's files are on a Modal Volume, not in the image.
ENV DREW_VOLUME_MOUNT=/andrew-distill
ENV DREW_KMODEL_RELATIVE_PATH=/kokoro/retrain_v3/stageA/step00900_kmodel.pth
ENV DREW_VOICE_RELATIVE_PATH=/kokoro/retrain_v3/stageA/step00900_voice.pt
ENV SOWELL_CPU_THREADS=2
ENV OMP_NUM_THREADS=2
ENV OPENBLAS_NUM_THREADS=2
ENV MKL_NUM_THREADS=2
ENV HF_HOME=/opt/hf
ENV PYTHONPATH=/opt/sowell/scripts

RUN python /opt/sowell/scripts/pack_main.py

WORKDIR /opt/sowell/scripts
CMD ["python", "synthesize.py", "--help"]
