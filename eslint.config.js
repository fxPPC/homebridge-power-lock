{
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": "./tsconfig.json"
  },
  "plugins": [
    "@typescript-eslint"
  ],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "rules": {
    "semi": ["error", "always"],
    "quotes": ["error", "single"],
    "@typescript-eslint/no-unused-vars": ["error"],
    "no-console": "off"
  }
}
