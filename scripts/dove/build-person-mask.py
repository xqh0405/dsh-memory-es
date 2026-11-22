#!/usr/bin/env python3
"""生成小鸽子皮肤的「人物遮罩」常量（DOVE_PERSON）。

为什么是手调多边形：自动阈值那条路实测走不通——闭运算会把丝带间隙一起填进去
（占 34.9% 面积），而很暗的头发又漏在外面。星点避让需要的是"人物所占屏幕区域"，
多边形最可控，画完渲染回背景逐轮对齐即可。

**椭圆星轨参数不在这里生成**：那四条椭圆是拿画面里星轨的极值点手量、画回背景
对齐出来的（见 client.js 的 DOVE_ELLIPSES）。自动 RANSAC 拟合实测不可靠：
混杂轨迹下内点率只有 16%，还会拟合出落在空白处的椭圆。

用法：
  FFMPEG=/path/to/ffmpeg python3 scripts/dove/build-person-mask.py <背景视频>
  FFMPEG=/path/to/ffmpeg python3 scripts/dove/build-person-mask.py <背景视频> --preview mask.ppm

输出：stdout 打印 54x36 的 0/1 网格（贴进 client.js 的 DOVE_PERSON）；
      加 --preview 时另写一张 PPM，把它跟背景叠起来看就能对轮廓。
"""
import math
import os
import subprocess
import sys

W, H = 1080, 720
FF = os.environ.get('FFMPEG', 'ffmpeg')

# 人物外轮廓（沿人物边缘走一圈，顺时针）。坐标是 1080x720 设计系。
# 2026-11-21 对着网格图量的一版：头发顶 → 右翼 → 躯干右下 → 左臂下缘 → 左臂上缘。
POLY = [
    [460, 0], [700, 0], [800, 10], [860, 50], [930, 20], [1010, 0], [1080, 20],
    [1080, 190], [1030, 215], [960, 225], [900, 260],
    [880, 340], [870, 430], [845, 510], [800, 575], [760, 635], [715, 690], [690, 720],
    [350, 720], [330, 650], [320, 580], [250, 520], [170, 470], [90, 425], [0, 400],
    [0, 300], [90, 285], [190, 275], [280, 265], [350, 250], [410, 235],
    [450, 180], [455, 90],
]


def grab_rgb(path):
    out = subprocess.run(
        [FF, '-hide_banner', '-loglevel', 'error', '-ss', '0.3', '-i', path,
         '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        capture_output=True, check=True).stdout
    assert len(out) == W * H * 3, len(out)
    return out


def point_in_poly(x, y, poly):
    """射线法。"""
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-9) + x1
            if x < xin:
                inside = not inside
    return inside


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    preview = '--preview' in sys.argv
    video = args[0] if args else 'comment_5810aeb8d71e8fad83ce000c8feb2759.mp4'

    rgb = grab_rgb(video)
    luma = [(rgb[i * 3] * 299 + rgb[i * 3 + 1] * 587 + rgb[i * 3 + 2] * 114) // 1000
            for i in range(W * H)]

    mask = bytearray(W * H)
    hit = 0
    for y in range(H):
        row = y * W
        for x in range(W):
            if point_in_poly(x, y, POLY):
                mask[row + x] = 1
                hit += 1
    print('# 多边形覆盖 %.1f%%' % (100.0 * hit / (W * H)), file=sys.stderr)

    # 降采样 54x36：格心取样（每格 20px，边界误差可忽略）
    cells_w, cells_h = 54, 36
    grid = []
    filled = 0
    for gy in range(cells_h):
        line = ''
        for gx in range(cells_w):
            cx = (gx + 0.5) * W / cells_w
            cy = (gy + 0.5) * H / cells_h
            v = point_in_poly(cx, cy, POLY)
            line += '1' if v else '0'
            filled += 1 if v else 0
        grid.append(line)
    print('# 遮罩格 %d/%d = %.1f%%' % (filled, cells_w * cells_h,
                                       100.0 * filled / (cells_w * cells_h)), file=sys.stderr)
    for row in grid:
        print("      '%s'," % row)

    if preview:
        buf = bytearray()
        for i in range(W * H):
            g = luma[i] * 30 // 100
            if mask[i]:
                buf += bytes((min(255, g + 26), min(255, g + 66), min(255, g + 138)))
            else:
                buf += bytes((g, g, g))
        path = args[1] if len(args) > 1 else 'mask.ppm'
        open(path, 'wb').write(b'P6\n%d %d\n255\n' % (W, H) + bytes(buf))
        print('# 预览已写 %s' % path, file=sys.stderr)


if __name__ == '__main__':
    main()
