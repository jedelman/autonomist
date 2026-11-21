// pds.js imports its account app from @pdsjs/account-ui, a package that isn't published to npm
// (2.5.2). wrangler.toml aliases the import here. With no account app, pds.js serves its
// server-rendered account pages instead. Remove this file and the alias once the package is on npm.
export const accountApp = null
