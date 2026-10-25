/**
 * tsdown 配置：本插件只有 Node 端（无浏览器 Toolview），所以只打一个 ESM 产物。
 * @deepseek-ai/* 都是 type-only 或由宿主 Loader 提供，不打进产物；
 * schemastery 必须保持 external——Loader 校验 Config 时要用它自己那份实例。
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
    neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
  },
} satisfies UserConfig
