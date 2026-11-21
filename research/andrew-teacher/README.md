# Andrew Kokoro teacher: evidence bundle (research only)

Weights (GitHub release `andrew-teacher-evidence-2026-11-14`, download with `gh release download andrew-teacher-evidence-2026-11-14`):
- epoch_2nd_00002_kmodel.pth + epoch_2nd_00002_voice.pt: final fine-tuned teacher (stage 2)
- epoch_1st_00002_kmodel.pth + epoch_1st_00002_voice.pt: end of stage 1

Base model: hexgrad/Kokoro-82M at revision f3ff3571791e39611d31c381e3a41a3af07b4987 (kokoro pip package, KModel loads these .pth files).

logs/: StyleTTS2 training configs and logs (v1 = run that produced the exported teacher; v2 = later run), train/val/OOD lists.
samples/: teacher renders (p_teacher_full.wav, teacher_long.wav, teacher_paragraph.wav, eval_final/*), stock Kokoro using the teacher's voice tensor (p_stock_teacherpack.wav), original Andrew book reference clips (andrew_reference_book_clips/, andrew_original_book_clip.mp3; the book was rendered at 0.85x speed).
Scores: teacher ECAPA 0.936 vs Edge Andrew (ceiling 0.954), WER 3.0%.
