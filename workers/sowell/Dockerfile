# Kokoro CPU image for Drew, Walter, George, and Heart. CPU-only: no CUDA
# torch, ONNX Runtime by default (`KOKORO_RUNTIME=onnx`), torch kept for the
# fallback runtime (`KOKORO_RUNTIME=torch`) and for the ONNX exporter.
# Provider-agnostic: nothing here is Modal-specific; `modal/sowell_worker.py`
# only adds FastAPI on top.
# Official Python, not Debian
# apt python, so later `python -m pip` layers are not blocked by PEP 668.
# Do not apt-install python3. Do not query pip's config. The voice pack is a
# build input and is not part of the Next.js bundle.
#
#   docker build -f workers/sowell/Dockerfile .
# Place voices/sowell/am_sowell_avg.pt (gitignored) before building.
# The pack check fails the image if the hash or layout is wrong.
#
# Cold start. Everything Kokoro and misaki fetch at runtime is baked here, so
# `@modal.enter` on a scaled-from-zero container only reads local files:
#
#   * `en_core_web_sm` (spaCy English). misaki's `en.G2P` runs
#     `spacy.cli.download` on first use when the package is missing. That was
#     a network fetch in the middle of the first section of a book.
#   * `hexgrad/Kokoro-82M` `config.json` and `kokoro-v1_0.pth` at the pinned
#     revision, plus the `bm_george.pt` and `af_heart.pt` voices. `engine.py`
#     asks `hf_hub_download` for these, which would otherwise touch the Hub.
#   * `HF_HOME` is set **before** those fetches so the runtime reads the same
#     cache directory the build filled.
#
# `espeak-ng` is an apt package (misaki's OOD-word fallback), already here.
# There is no nltk data to fetch: misaki does not use nltk.
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

# Set before any Hugging Face download below, so the build and the runtime
# share one cache directory.
ENV HF_HOME=/opt/hf
ENV HF_HUB_DISABLE_TELEMETRY=1

# CPU-only torch first, from PyTorch's CPU index, so `kokoro`'s `torch`
# requirement is already met and pip never pulls the CUDA wheel. The CUDA
# wheel was ~2.9 GB of RSS per process after `import torch` alone.
ARG TORCH_VERSION=2.15.0
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch==${TORCH_VERSION}+cpu"
COPY scripts/sowell/requirements.txt /tmp/sowell-requirements.txt
RUN pip install --no-cache-dir -r /tmp/sowell-requirements.txt \
  && python -c "import kokoro, torch; assert torch.__version__.endswith('+cpu'), torch.__version__; assert not torch.cuda.is_available()" \
  && python -c "import onnxruntime as o; assert 'CPUExecutionProvider' in o.get_available_providers()" \
  && python -c "import importlib.metadata as m; assert not any(d.metadata['Name'].lower().startswith('nvidia-') for d in m.distributions()), 'CUDA wheels in a CPU image'"
# misaki[en] pulls spacy-curated-transformers, a spaCy plugin that imports
# torch on spaCy start-up. misaki only uses it for trf=True; Kokoro runs
# trf=False. Without it the ONNX process never imports torch (onnx_engine.py
# `block_torch_import`).
RUN pip uninstall -y spacy-curated-transformers

# spaCy English model, pinned to the wheel for spaCy 3.8. The URL is the
# GitHub release, not a moving `spacy download` alias. A spaCy that is not
# 3.8.x fails this layer instead of publishing an image whose G2P cannot load
# the model it ships.
ENV SPACY_MODEL_VERSION=3.8.0
RUN python -c "import spacy; v=spacy.__version__.split('.'); assert (v[0], v[1]) == ('3','8'), f'need spaCy 3.8.x for en_core_web_sm 3.8.0, got {spacy.__version__}'" \
  && pip install --no-cache-dir \
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-${SPACY_MODEL_VERSION}/en_core_web_sm-${SPACY_MODEL_VERSION}-py3-none-any.whl" \
  && python -c "import en_core_web_sm, spacy; nlp=spacy.load('en_core_web_sm'); assert nlp('The harbor was quiet.').text"

# Kokoro's config and weights, and the pinned British and American stock
# voices. The same revision `scripts/sowell/pack.py` checks. These land in
# $HF_HOME, so `engine.py`'s `hf_hub_download` calls are cache hits on a
# cold container.
ENV KOKORO_REVISION=f3ff3571791e39611d31c381e3a41a3af07b4987
RUN python -c "from huggingface_hub import hf_hub_download; [hf_hub_download(repo_id='hexgrad/Kokoro-82M', filename=f, revision='f3ff3571791e39611d31c381e3a41a3af07b4987') for f in ('config.json', 'kokoro-v1_0.pth')]"

COPY scripts/sowell /opt/sowell/scripts
COPY voices/sowell/manifest.json /opt/sowell/voices/manifest.json
COPY voices/sowell/am_sowell_avg.pt /opt/sowell/voices/am_sowell_avg.pt

# Official bm_george at the pinned Kokoro revision. The hash is the file
# from that revision, not a trained pack. A mismatch fails the image.
ENV GEORGE_VOICE=/opt/sowell/voices/bm_george.pt
ENV GEORGE_VOICE_SHA256=f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b
RUN python -c "import hashlib,os,shutil; from pathlib import Path; from huggingface_hub import hf_hub_download; p=Path(hf_hub_download(repo_id='hexgrad/Kokoro-82M', filename='voices/bm_george.pt', revision='f3ff3571791e39611d31c381e3a41a3af07b4987')); d=hashlib.sha256(p.read_bytes()).hexdigest(); assert d==os.environ['GEORGE_VOICE_SHA256'], d; shutil.copy(p, os.environ['GEORGE_VOICE'])"

# Official af_heart at the same pinned Kokoro revision. Stock pack on the
# base model, not Drew's fine-tune. A mismatch fails the image.
ENV HEART_VOICE=/opt/sowell/voices/af_heart.pt
ENV HEART_VOICE_SHA256=0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff
RUN python -c "import hashlib,os,shutil; from pathlib import Path; from huggingface_hub import hf_hub_download; p=Path(hf_hub_download(repo_id='hexgrad/Kokoro-82M', filename='voices/af_heart.pt', revision='f3ff3571791e39611d31c381e3a41a3af07b4987')); d=hashlib.sha256(p.read_bytes()).hexdigest(); assert d==os.environ['HEART_VOICE_SHA256'], d; shutil.copy(p, os.environ['HEART_VOICE'])"

ENV SOWELL_PACK=/opt/sowell/voices/am_sowell_avg.pt
ENV SOWELL_MANIFEST=/opt/sowell/voices/manifest.json
# Drew's files are on a Modal Volume, not in the image.
ENV DREW_VOLUME_MOUNT=/andrew-distill
ENV DREW_KMODEL_RELATIVE_PATH=/kokoro/retrain_v3/stageA/step00900_kmodel.pth
ENV DREW_VOICE_RELATIVE_PATH=/kokoro/retrain_v3/stageA/step00900_voice.pt
# Torch threads. `SOWELL_TORCH_THREADS` is what the container applies in
# `@modal.enter`; the OMP/BLAS/MKL variables stay in step so a library that
# reads them at import does not build a wider pool behind torch's back.
#
# 4 threads on Modal's 2 physical cores. Measured on the deployed image
# (`modal/sowell_bench.py`, Drew, cpu=2, two rounds x 2 repeats): 4 threads is
# ~1.5x faster than 2. Harbor paragraph, 719 chars, 39.7 s of audio:
#   2 threads: 25.3-27.1 s wall, RTF 1.46-1.57
#   4 threads: 16.5-19.3 s wall, RTF 2.06-2.41
# Prose and the short opening followed the same shape (prose RTF 1.25-1.57 →
# 1.80-2.47, opening 1.35-1.58 → 1.84-3.07).
# These apply to the torch fallback (`KOKORO_RUNTIME=torch`) only. The ONNX
# runtime sets its own pool per session (`KOKORO_ONNX_THREADS`).
ENV SOWELL_CPU_THREADS=4
ENV SOWELL_TORCH_THREADS=4
ENV SOWELL_TORCH_INTEROP_THREADS=1
ENV OMP_NUM_THREADS=4
ENV OPENBLAS_NUM_THREADS=4
ENV MKL_NUM_THREADS=4
ENV PYTHONPATH=/opt/sowell/scripts

RUN python /opt/sowell/scripts/pack_main.py

# ONNX graph, baked for the opt-in runtime. Stock Kokoro plus Walter's, George's and
# Heart's pinned packs, exported at build from the same pinned checkpoint and
# packs the torch runtime loads. Drew's graph is private: it is exported into
# his volume (`modal run modal/sowell_worker.py::export_drew_onnx`).
ENV KOKORO_ONNX_DIR=/opt/sowell/onnx
RUN python /opt/sowell/scripts/onnx_export.py stock --out /opt/sowell/onnx >/dev/null \
  && python -c "import sys; sys.path.insert(0,'/opt/sowell/scripts'); from pathlib import Path; from onnx_engine import read_manifest; read_manifest(Path('/opt/sowell/onnx'))"
# The image default is the torch fallback. A deploy that sets
# KOKORO_RUNTIME=onnx bakes that choice, and the stream count, over these
# (modal/sowell_worker.py image.env). One ORT thread when that runtime is on.
ENV KOKORO_RUNTIME=torch
ENV KOKORO_ONNX_THREADS=1
ENV KOKORO_STREAMS=1

WORKDIR /opt/sowell/scripts
CMD ["python", "synthesize.py", "--help"]
