#!/usr/bin/env python3

# Test what TTS packages are available
print("Checking for TTS packages...")

try:
    import indextts
    print("✓ Found indextts at:", indextts.__file__)
except ImportError:
    print("✗ indextts not found")

try:
    import index_tts
    print("✓ Found index_tts at:", index_tts.__file__)
except ImportError:
    print("✗ index_tts not found")

try:
    from indextts import IndexTTS
    print("✓ Found IndexTTS class")
except ImportError as e:
    print("✗ IndexTTS class not found:", e)

try:
    from index_tts import IndexTTS
    print("✓ Found IndexTTS class (alt)")
except ImportError as e:
    print("✗ IndexTTS class not found (alt):", e)

# Check all installed packages
import pkg_resources
installed_packages = [d.project_name for d in pkg_resources.working_set]
tts_packages = [pkg for pkg in installed_packages if 'tts' in pkg.lower() or 'index' in pkg.lower()]
print("TTS/Index related packages:", tts_packages)
