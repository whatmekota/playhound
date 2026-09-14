/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          50:  '#f8f8f8',
          100: '#efefef',
          200: '#dcdcdc',
          700: '#2a2a2a',
          800: '#1e1e1e',
          850: '#181818',
          900: '#111111',
          950: '#0a0a0a',
        },
        accent: {
          400: '#e879f9',
          500: '#d946ef',
          600: '#c026d3',
        }
      }
    }
  },
  plugins: [],
}
