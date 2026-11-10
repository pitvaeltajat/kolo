import nextConfig from 'eslint-config-next';

const config = [
  ...nextConfig,
  {
    rules: {
      // These React Compiler diagnostics are not part of Kolo's legacy lint baseline.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
];

export default config;
