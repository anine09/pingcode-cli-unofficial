import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**', // 纯类型定义，无运行时代码
        'src/bin/**', // CLI 入口，非业务代码
        'src/core/catalog/catalog.generated.ts', // 生成文件
      ],
    },
  },
});
