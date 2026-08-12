module.exports = function (eleventyConfig) {
  // static assets copied verbatim to the site root
  eleventyConfig.addPassthroughCopy({ "src/style.css": "style.css" });
  eleventyConfig.addPassthroughCopy({ "src/main.js": "main.js" });
  eleventyConfig.addPassthroughCopy({ "src/og.png": "og.png" });
  eleventyConfig.addPassthroughCopy({ "src/CNAME": "CNAME" });
  eleventyConfig.addPassthroughCopy({ "src/talks": "talks" });

  // one collection, newest first
  eleventyConfig.addCollection("post", (c) =>
    c.getFilteredByGlob("src/posts/*.{html,md}").sort((a, b) => b.date - a.date)
  );

  const MON = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  eleventyConfig.addFilter("shortdate", (d) => { const x = new Date(d); return MON[x.getUTCMonth()] + " " + x.getUTCDate(); });
  eleventyConfig.addFilter("readdate",  (d) => { const x = new Date(d); return MON[x.getUTCMonth()] + " " + x.getUTCDate() + ", " + x.getUTCFullYear(); });
  eleventyConfig.addFilter("isodate",   (d) => new Date(d).toISOString());

  return {
    // post bodies are raw HTML — never run them through a template engine (keeps code blocks intact)
    htmlTemplateEngine: false,
    // future posts written in markdown can still use {{ }} if wanted
    markdownTemplateEngine: "njk",
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
  };
};
