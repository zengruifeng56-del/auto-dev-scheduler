import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import { builtinModules } from 'module';

process.env.SASS_SILENCE_DEPRECATIONS = 'legacy-js-api';

const mainExternals = [
  'electron',
  'tree-kill',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`)
];

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': path.resolve(__dirname, 'src/shared'),
              '@main': path.resolve(__dirname, 'src/main')
            }
          },
          build: {
            outDir: 'dist/main',
            minify: false,
            sourcemap: true,
            rollupOptions: {
              external: mainExternals
            }
          }
        },
        onstart(options) {
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          const appPath = path.resolve(__dirname);
          options.startup(['--no-sandbox', appPath], { env, cwd: appPath });
        }
      },
      {
        entry: 'src/preload/index.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': path.resolve(__dirname, 'src/shared')
            }
          },
          build: {
            outDir: 'dist/preload',
            lib: {
              entry: 'src/preload/index.ts',
              formats: ['cjs'],
              fileName: () => 'index.js'
            },
            rollupOptions: {
              external: (id) => {
                if (id === 'electron' || id.startsWith('electron/')) return true;
                return false;
              }
            }
          }
        },
        onstart(options) {
          options.reload();
        }
      }
    ]),
    renderer({
      nodeIntegration: false
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main')
    }
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  },
  css: {
    preprocessorOptions: {
      scss: {
        silenceDeprecations: ['legacy-js-api']
      }
    }
  },
  server: {
    port: 5174
  }
});
