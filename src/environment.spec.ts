import { resolveEnvironment } from './environment';

describe('resolveEnvironment', () => {
  it.each(['development', 'test', 'staging'])('allows %s', (env) => {
    expect(resolveEnvironment(env)).toBe(env);
  });

  it('refuses production until launch gates and founder approval', () => {
    expect(() => resolveEnvironment('production')).toThrow(/not allowed/);
  });
});
