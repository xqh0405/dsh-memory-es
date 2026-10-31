/**
 * tsdown 配置：本插件只有 Node 端（无浏览器 Toolview），所以只打一个 ESM 产物。
 * 四个 @deepseek-ai/* 都由宿主 Loader 提供（peerDependencies），一律不打进产物：
 * 打进去会把宿主那份的实现固化进插件，宿主升级后两份代码各跑各的。
 * schemastery 尤其必须 external——Loader 校验 Config 时要用它自己那份实例。
 */
import type { UserConfig } from 'tsdown'

export default {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ],
  },
} satisfies UserConfig
