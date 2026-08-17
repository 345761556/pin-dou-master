import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("ERROR: Pillow 库未安装，请运行: pip install Pillow")
    sys.exit(1)

# 版本校验：rounded_rectangle 需要 Pillow >= 8.2.0（旧版本会因缺少该方法而 AttributeError）
from PIL import __version__ as _PILLOW_VERSION


def _parse_version(v):
    """将 '8.2.0' 之类版本串解析为可比较的元组（忽略非数字后缀）"""
    parts = []
    for seg in v.split('.'):
        num = ''
        for ch in seg:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    return tuple(parts)


if _parse_version(_PILLOW_VERSION) < _parse_version('8.2.0'):
    print("ERROR: 当前 Pillow 版本 %s 过低，rounded_rectangle 需要 Pillow >= 8.2.0，请运行: pip install --upgrade Pillow" % _PILLOW_VERSION)
    sys.exit(1)

# ========== 配置参数 ==========
script_dir = os.path.dirname(os.path.abspath(__file__))
icons_dir = os.path.join(script_dir, 'images', 'icons')

SIZE = 81

COLORS = {
    'inactive': '#999999',
    'active': '#FF6B6B',
}

ICONS = [
    ('create',        'create',   'inactive'),
    ('create-active', 'create',   'active'),
    ('gallery',       'gallery',  'inactive'),
    ('gallery-active','gallery',  'active'),
    ('profile',       'profile',  'inactive'),
    ('profile-active','profile',  'active'),
]
# ==============================

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

# ========== 图标绘制策略注册表 ==========
_drawers = {}

def register_drawer(name):
    """装饰器：注册图标绘制策略"""
    def decorator(func):
        _drawers[name] = func
        return func
    return decorator

def make_icon(filename, icon_type, color, size=SIZE):
    """通用图标生成器 - 符合开闭原则"""
    if icon_type not in _drawers:
        raise ValueError(f'未知图标类型: {icon_type}')
    
    try:
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        _drawers[icon_type](draw, size, hex_to_rgb(color))
        img.save(filename, 'PNG')
        print(f'OK {filename}')
    except PermissionError:
        print(f'ERROR: 权限不足，无法写入文件: {filename}')
        raise
    except OSError as e:
        print(f'ERROR: 文件操作失败: {e}')
        raise

# ========== 具体图标绘制策略 ==========
@register_drawer('create')
def draw_create(draw, size, color):
    """加号图标 - 尺寸自适应"""
    cx = size // 2
    cy = size // 2
    unit = size / 81  # 以基准尺寸 81 为参考

    # 四个端点圆形
    for dx, dy in [(-14,0),(14,0),(0,-14),(0,14)]:
        r = 4 * unit
        draw.ellipse([cx+dx*unit-r, cy+dy*unit-r, cx+dx*unit+r, cy+dy*unit+r], fill=color)
    # 横竖条
    draw.rectangle([cx-14*unit, cy-4*unit, cx+14*unit, cy+4*unit], fill=color)
    draw.rectangle([cx-4*unit, cy-14*unit, cx+4*unit, cy+14*unit], fill=color)

@register_drawer('gallery')
def draw_gallery(draw, size, color):
    """2x2 网格 - 尺寸自适应"""
    unit = size / 81

    for row in range(2):
        for col in range(2):
            x = (24 + col * 20) * unit
            y = (24 + row * 20) * unit
            draw.rounded_rectangle([x, y, x+14*unit, y+14*unit], radius=3*unit, fill=color)

@register_drawer('profile')
def draw_profile(draw, size, color):
    """人物头像：头+身 - 尺寸自适应"""
    # 基准尺寸 81 下的比例参数
    unit = size / 81
    cx = size // 2

    # 头：圆形，中心偏上
    head_r = 7.5 * unit
    head_cy = 23.5 * unit
    draw.ellipse([cx-head_r, head_cy-head_r, cx+head_r, head_cy+head_r], fill=color)

    # 身：椭圆，中心偏下
    body_w = 17.5 * unit
    body_h = 11 * unit
    body_cy = 51 * unit
    draw.ellipse([cx-body_w, body_cy-body_h, cx+body_w, body_cy+body_h], fill=color)

# ========== 主程序入口 ==========
if __name__ == '__main__':
    # 目录不存在时自动创建（exist_ok=True 避免已存在时报错），
    # 新克隆项目 / CI 环境无需手动建目录即可直接运行生成 tabBar 图标
    os.makedirs(icons_dir, exist_ok=True)

    if not os.access(icons_dir, os.W_OK):
        print(f'ERROR: 目录不可写: {icons_dir}')
        sys.exit(1)

    for name, icon_type, color_key in ICONS:
        make_icon(os.path.join(icons_dir, f'{name}.png'), icon_type, COLORS[color_key])

    print('All icons generated successfully!')
