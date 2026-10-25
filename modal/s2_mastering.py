"""Delivery mastering for S2-Pro narrations.

This is the chain measured on the owner's Ntw voice in October 2026. S2-Pro
loses about 12 dB around 5-8 kHz and 27 dB around 8-10 kHz against the source
clip, and carries 4-6 dB too much 80-640 Hz. The chain below removes the
low-mid buildup, takes down the 3.4 kHz presence peak S2 already has, and puts
air back with a high shelf. The book-level loudness pass is left to the app.

Keep in sync with `MODAL_S2_MASTERING` in src/lib/tts/mastering.ts.
"""

# ffmpeg filter chain. Order matters: rumble, mud, presence, air, codec ceiling.
S2_SPECTRAL_CHAIN = ",".join([
    "highpass=f=70:poles=2",
    "equalizer=f=190:width_type=o:width=1.2:g=-3.2",
    "equalizer=f=430:width_type=o:width=1.3:g=-2.4",
    "equalizer=f=3400:width_type=o:width=1.4:g=-1.5",
    "equalizer=f=6800:width_type=o:width=0.9:g=-2.0",
    "equalizer=f=8000:width_type=o:width=1.0:g=+5.0",
    "lowpass=f=15500:poles=2",
])

# The app masters each section to -19 LUFS / -3 dBTP (audiobook, not podcast
# -16). The container only does spectral work and leaves gain to that pass.
SECTION_SAMPLE_RATE = 44100
SECTION_MP3_BITRATE = "128k"
