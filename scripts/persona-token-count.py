#!/usr/bin/env python3
"""实测人设文本的 token 数（DeepSeek 官方 tokenizer）。

为什么需要它：项目里既有的估算口径「token ≈ 字符 / 2」（见 src/config.ts:663、
src/recall-shadow.ts:69）对中文叙述会低估约 31%，而「1 字 ≈ 1.5 token」又会高估
一倍——两边的误差都够让「该不该升细腻版」的判断反过来。所以量一次，别估。

依赖（不随包分发，按需自装）：
    pip install tokenizers
    # 词表约 7.8 MB，放缓存目录即可
    curl -L -o "$DS_TOKENIZER_PATH" \\
      https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json

用法：
    scripts/persona-token-count.py                      # 跑 persona/presets/*.md
    scripts/persona-token-count.py persona/seed.md      # 指定文件
    scripts/persona-token-count.py --chars 300 2400     # 只按字数外推
    scripts/persona-token-count.py --text "要测的文本"   # 直接测一段
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_TOKENIZER = pathlib.Path(
    os.environ.get('DS_TOKENIZER_PATH', '~/.cache/dsh-mem/ds-tokenizer.json')
).expanduser()

# 实测锚点：纯中文叙述 0.725~0.752 token/字，取中位 0.73 做外推
CJK_RATIO = 0.73


def load_tokenizer():
    if not DEFAULT_TOKENIZER.exists():
        sys.exit(
            f'找不到词表：{DEFAULT_TOKENIZER}\n'
            '请先下载 DeepSeek tokenizer（见本文件头注释），或用环境变量 '
            'DS_TOKENIZER_PATH 指定路径。'
        )
    try:
        from tokenizers import Tokenizer
    except ImportError:
        sys.exit('缺少依赖：pip install tokenizers')
    return Tokenizer.from_file(str(DEFAULT_TOKENIZER))


def measure(tok, label: str, text: str) -> tuple[int, int]:
    chars = len(''.join(text.split()))  # 去空白字符，与文档口径一致
    n = len(tok.encode(text).ids)
    ratio = n / chars if chars else 0
    inv = (1 / ratio) if ratio else 0
    print(f'{label:34s} {chars:>6d} 字  {n:>6d} token  '
          f'({ratio:.3f} token/字 ≈ 1 token / {inv:.2f} 字)')
    return chars, n


def main() -> None:
    ap = argparse.ArgumentParser(description='实测人设文本 token 数')
    ap.add_argument('files', nargs='*', help='要测量的文本文件（默认跑 presets 全部）')
    ap.add_argument('--chars', nargs='+', type=int, help='只按字数外推')
    ap.add_argument('--text', help='直接测量一段文本')
    args = ap.parse_args()

    tok = load_tokenizer()

    if args.chars:
        print(f'按实测比值 {CJK_RATIO} token/字 外推：')
        for c in args.chars:
            print(f'  {c:>5d} 字 ≈ {round(c * CJK_RATIO):>6d} token')
        return

    if args.text:
        measure(tok, '（命令行文本）', args.text)
        return

    files = [pathlib.Path(f) for f in args.files]
    if not files:
        files = sorted((ROOT / 'persona' / 'presets').glob('*.md'))
    if not files:
        sys.exit('没有可测量的文件')

    for f in files:
        if not f.exists():
            print(f'跳过（不存在）：{f}')
            continue
        measure(tok, f.name, f.read_text(encoding='utf-8'))


if __name__ == '__main__':
    main()
