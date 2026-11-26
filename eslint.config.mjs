import {defineConfig,globalIgnores} from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
export default defineConfig([
 globalIgnores(['node_modules/**','dist/**','tests/**','scripts/**','.venv/**','.venv-*/**','work/**','docs/**','esbuild.config.mjs','eslint.config.mjs']),
 ...obsidianmd.configs.recommended,
 {languageOptions:{parserOptions:{projectService:true}}},
]);
