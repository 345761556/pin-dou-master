const { clampDisplayNumber } = require('../../utils/util');

Component({
  properties: {
    materials: { type: Array, value: [] },
    totalBeads: { type: String, value: '' },
    physicalSize: { type: String, value: '' },
    showCopy: { type: Boolean, value: true },
    cols: { type: Number, value: 0 },
    rows: { type: Number, value: 0 },
    colorCount: { type: Number, value: 0 }
  },
  methods: {
    onCopy() {
      // 防御：totalBeads 声明为 String，但父组件可能直接传入 Number（如 templateData.totalBeads）
      // 统一转字符串后再去逗号，避免 .replace is not a function 崩溃
      const totalBeadsNum = parseInt(String(this.data.totalBeads).replace(/,/g, ''), 10) || 0;
      const suggestBeads = Math.ceil(totalBeadsNum * 1.1);
      const lines = [
        '🎨 拼豆材料清单',
        '━━━━━━━━━━━━━',
        '模板尺寸: ' + this.data.cols + ' × ' + this.data.rows + ' (' + this.data.physicalSize + ')',
        '拼豆总数: ' + this.data.totalBeads + ' 颗',
        '颜色种类: ' + this.data.colorCount + ' 种',
        '━━━━━━━━━━━━━',
        ''
      ];

      // 防御：父组件传入 null/非数组时（如脏历史数据），forEach 会抛 TypeError。
      // 与 gallery.js 同源防护口径一致——确保「复制清单」始终可用。
      const materials = Array.isArray(this.data.materials) ? this.data.materials : [];
      materials.forEach(function(item, idx) {
        // 防御字段级脏数据：元素可能缺 color 字段，直接 item.color.xxx 会抛 TypeError；
        // 缺色号的项用占位符展示，保证「复制清单」始终可用（与 renderTemplate 同源防护）。
        const c = (item && item.color) ? item.color : {};
        const name = c.name || '未知颜色';
        const cid = (c.id != null) ? c.id : '?';
        const hex = c.hex || '#CCCCCC';
        // 元素级 count 脏值钳制（与 template 页同源）：避免脏 count=1e20 在清单/建议购买数里显示超长串
        const count = clampDisplayNumber(item.count, 20000);
        lines.push(
          (idx + 1) + '. ' + name + ' (' + cid + ') ' + hex + ' × ' + (count || 0) + '颗 (' + (item.percentText || '') + ')'
        );
      });

      lines.push(
        '',
        '━━━━━━━━━━━━━',
        '合计: ' + this.data.totalBeads + ' 颗',
        '建议购买: ' + suggestBeads + ' 颗 (含10%备用)',
        '',
        '由「拼豆大师」小程序生成'
      );

      wx.setClipboardData({
        data: lines.join('\n'),
        success: () => wx.showToast({ title: '清单已复制', icon: 'success' })
      });
    }
  }
})
