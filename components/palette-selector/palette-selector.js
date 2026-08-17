Component({
  properties: {
    metaList: { type: Array, value: [] },
    activeKey: { type: String, value: '' }
  },
  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key;
      if (!key || key === this.data.activeKey) return;
      this.triggerEvent('change', { key });
    }
  }
})
