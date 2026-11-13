# Atribuições

## Arte e sprites

**Toda a arte do agent-office é gerada proceduralmente em código** — cenário, móveis, personagens, balões e ícones são desenhados em tempo de execução pelo front-end (`packages/web/src`) e convertidos em texturas. O repositório não contém nem baixa imagens, spritesheets, fontes ou áudio de terceiros.

Por ser código original deste projeto, a arte está coberta pela mesma licença [MIT](LICENSE).

Se algum dia forem adicionados assets externos, eles devem ter licença clara (por exemplo CC0, como os pacotes da [Kenney](https://kenney.nl)) e ser listados aqui com autor, origem e licença.

## Bibliotecas

Dependências de execução, todas com licença MIT:

| Biblioteca | Uso | Licença |
|---|---|---|
| [Fastify](https://fastify.dev) e `@fastify/static` | servidor HTTP e arquivos estáticos | MIT |
| [ws](https://github.com/websockets/ws) | WebSocket | MIT |
| [chokidar](https://github.com/paulmillr/chokidar) | observação de arquivos | MIT |
| [PixiJS](https://pixijs.com) | renderização 2D | MIT |
| [React](https://react.dev) e React DOM | interface | MIT |

Ferramentas de desenvolvimento: [Vite](https://vite.dev) (MIT), [TypeScript](https://www.typescriptlang.org) (Apache-2.0), [Vitest](https://vitest.dev) (MIT), [ESLint](https://eslint.org) e [typescript-eslint](https://typescript-eslint.io) (MIT), [globals](https://github.com/sindresorhus/globals) (MIT).

O SQLite é o módulo nativo `node:sqlite` do Node.js (domínio público).
