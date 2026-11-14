"""Figure 7: what the training logs show (loss curves, GAN switch-on, NaN run)."""
import sys, re, numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
sys.path.insert(0,'/tmp/work')
plt.rcParams.update({'figure.dpi':150,'savefig.bbox':'tight','font.size':8})

# ---- stage 2 ----
pat=re.compile(r'Epoch \[(\d+)/3\], Step \[(\d+)/(\d+)\], Loss: ([\d.]+), Disc Loss: ([\d.]+), '
               r'Dur Loss: ([\d.]+), CE Loss: ([\d.]+), Norm Loss: ([\d.]+), F0 Loss: ([\d.]+), '
               r'LM Loss: ([\d.]+), Gen Loss: ([\d.]+)')
s2=[]
for line in open('/agent/repos/Echomancer/research/andrew-teacher/logs/stage2.log'):
    m=pat.search(line)
    if m: s2.append([float(x) for x in m.groups()])
a=np.array(s2)
# build a global step index: epochs 1,2 have 614 steps; epoch 3 continues
x=[]; 
for r in a:
    x.append((r[0]-1)*614 + r[1])
x=np.array(x)

fig,axes=plt.subplots(1,3,figsize=(11,3.0))

ax=axes[0]
ax.plot(x, a[:,4], lw=1.0, color='#2b6cb0', label='Discriminator loss')
ax.plot(x, a[:,10], lw=1.0, color='#c53030', label='Generator (GAN) loss')
ax.axvline(2*614, color='k', ls='--', lw=.8)
ax.annotate('discriminators\nswitch on', xy=(2*614, 5.0), xytext=(560, 5.6),
            fontsize=6.5, arrowprops=dict(arrowstyle='->', lw=.6))
ax.axvspan(2*614, 3*614, color='orange', alpha=.12)
ax.text(2.5*614, 1.0, 'exported\ncheckpoint\nis here', ha='center', fontsize=6.5, color='#8a4b00')
ax.set_xlabel('training step'); ax.set_ylabel('loss'); ax.legend(fontsize=6)
ax.set_title('Stage 2: GAN only ran in the last epoch')
ax.grid(alpha=.25)

ax=axes[1]
ax.plot(x, a[:,6], lw=1.0, color='#2f855a', label='Duration loss')
ax.plot(x, a[:,9], lw=1.0, color='#6b46c1', label='F0 loss')
ax.set_yscale('log'); ax.set_xlabel('training step')
ax.legend(fontsize=6); ax.grid(alpha=.25)
ax.set_title('Stage 2: prosody loss plateaus early')

ax=axes[2]
ax.plot(x, a[:,3], lw=1.0, color='#b7791f', label='Mel (running)')
ax.set_xlabel('training step'); ax.legend(fontsize=6); ax.grid(alpha=.25)
ax.set_title('Stage 2: mel loss vs steps (20 epochs would be\n~12x further right)')
ax.axvline(3*614, color='r', ls=':', lw=1)
ax.text(3*614, ax.get_ylim()[1]*0.9, ' training ended', fontsize=6, color='r')

fig.tight_layout(); fig.savefig('/tmp/work/finalfigs/fig7_training.png'); plt.close(fig)
print('wrote fig7')

# ---- stage 1 ----
pat1=re.compile(r'Epoch \[(\d+)/3\], Step \[(\d+)/409\], Mel Loss: ([\d.]+|nan), Gen Loss: ([\d.a-z]+), '
                r'Disc Loss: ([\d.a-z]+)')
s1=[]
for line in open('/agent/repos/Echomancer/research/andrew-teacher/logs/stage1.log'):
    m=pat1.search(line)
    if m:
        try: s1.append([float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)), float(m.group(5))])
        except ValueError: s1.append([float(m.group(1)), float(m.group(2)), np.nan, np.nan, np.nan])
b=np.array(s1)
if len(b):
    xx=(b[:,0]-1)*409+b[:,1]
    fig,ax=plt.subplots(figsize=(6.4,2.8))
    ax.plot(xx,b[:,2],lw=1.0,color='#2b6cb0',label='Mel loss')
    ax.set_xlabel('step (successful stage-1 run)'); ax.set_ylabel('mel loss')
    ax2=ax.twinx(); ax2.plot(xx,b[:,4],lw=.9,color='#c53030',alpha=.75,label='Disc loss')
    ax2.set_ylabel('disc loss',color='#c53030')
    ax.grid(alpha=.25)
    ax.set_title('Stage 1: 3 epochs, 1227 steps — mel still falling, discriminator stuck ~4.0')
    fig.tight_layout(); fig.savefig('/tmp/work/finalfigs/fig8_stage1.png'); plt.close(fig)
    print('wrote fig8', len(b), 'points')
