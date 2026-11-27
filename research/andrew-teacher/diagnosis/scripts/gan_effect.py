"""Quantify exactly what the GAN switch-on did to the losses."""
import re, numpy as np
pat=re.compile(r'Epoch \[(\d+)/3\], Step \[(\d+)/(\d+)\], Loss: ([\d.]+), Disc Loss: ([\d.]+), '
               r'Dur Loss: ([\d.]+), CE Loss: ([\d.]+), Norm Loss: ([\d.]+), F0 Loss: ([\d.]+), '
               r'LM Loss: ([\d.]+), Gen Loss: ([\d.]+)')
rows=[]
for line in open('/agent/repos/Echomancer/research/andrew-teacher/logs/stage2.log'):
    m=pat.search(line)
    if m: rows.append([float(x) for x in m.groups()])
a=np.array(rows)
EP,ST,TOT,MEL,DISC,DUR,CE,NORM,F0,LM,GEN=range(11)
# last 30 of the pre-GAN phase (epochs 1-2)
pre=a[(a[:,EP]<=2)]
pre_late=pre[-30:]
gan=a[a[:,DISC]>0]
print('STAGE 2 — "Loss" column is the running MEL loss (train_second.py: running_loss += loss_mel).')
print()
def st(name, arr):
    print(f'{name:34s} mel {arr[:,MEL].mean():.4f}  F0 {arr[:,F0].mean():.3f}  '
          f'LM {arr[:,LM].mean():.3f}  dur {arr[:,DUR].mean():.4f}  CE {arr[:,CE].mean():.4f}')
st('epochs 1-2 (no GAN), last 30 logs', pre_late)
st('epoch 3 (GAN on), first 30 logs', gan[:30])
st('epoch 3 (GAN on), last 30 logs', gan[-30:])
print()
print(f'MEL loss jump at GAN onset : {pre_late[:,MEL].mean():.4f} -> {gan[:30][:,MEL].mean():.4f} '
      f'({100*(gan[:30][:,MEL].mean()/pre_late[:,MEL].mean()-1):+.0f}%)')
print(f'F0 loss jump at GAN onset  : {pre_late[:,F0].mean():.3f} -> {gan[:30][:,F0].mean():.3f} '
      f'({100*(gan[:30][:,F0].mean()/pre_late[:,F0].mean()-1):+.0f}%)')
print(f'LM loss jump at GAN onset  : {pre_late[:,LM].mean():.3f} -> {gan[:30][:,LM].mean():.3f} '
      f'({100*(gan[:30][:,LM].mean()/pre_late[:,LM].mean()-1):+.0f}%)')
print(f'Duration loss              : {pre_late[:,DUR].mean():.4f} -> {gan[-30:][:,DUR].mean():.4f} (unchanged)')
print(f'CE loss                    : {pre_late[:,CE].mean():.4f} -> {gan[-30:][:,CE].mean():.4f} (unchanged)')
print()
print('Discriminator loss over the GAN phase (a healthy GAN oscillates near 0.7-1.4 per head):')
print(f'  min {gan[:,DISC].min():.2f}  max {gan[:,DISC].max():.2f}  mean {gan[:,DISC].mean():.2f}')
print('  (StyleTTS2 sums both MPD and MSD, each r_loss+g_loss, so 4 heads: ~4.0 means both')
print('   discriminators are at the random-guess point and the generator is not catching up.)')
print()
print('Exported checkpoints: epoch_1st_00002 / epoch_2nd_00002 -> 3rd epoch, i.e. 2 of 3 epochs done.')
print('Config asked for epochs_1st=3, epochs_2nd=3 (StyleTTS2 reference config uses 200 / 100).')
