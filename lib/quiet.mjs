// 必须最先被导入：node:sqlite 会打印 ExperimentalWarning，钩子的 stderr 要保持干净
process.removeAllListeners('warning')
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w) })
