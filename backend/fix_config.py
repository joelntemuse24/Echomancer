import re

with open('/home/user/Echomancer/backend/pretrained_models/CosyVoice2-0.5B/cosyvoice2.yaml', 'r') as f:
    content = f.read()

content = content.replace("qwen_pretrain_path: ''", "qwen_pretrain_path: 'CosyVoice-BlankEN'")

with open('/home/user/Echomancer/backend/pretrained_models/CosyVoice2-0.5B/cosyvoice2.yaml', 'w') as f:
    f.write(content)

print('Fixed config')
