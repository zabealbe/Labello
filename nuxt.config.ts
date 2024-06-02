// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: false,
  modules: ["@nuxt/eslint", "@nuxt/fonts", "@vueuse/nuxt"],
  devtools: {
    enabled: true,
  },
  typescript: {
    strict: false,
  },
  eslint: {
    config: {
      stylistic: {
        commaDangle: "never",
        braceStyle: "1tbs",
      },
    },
  },
  css: ["./assets/css/menu.css", "./assets/css/main.css"],
});
