# eve package artifacts

The trusted package project builds an eve tarball from each `vercel/eve` `main` commit and uploads immutable SHA-addressed artifacts to private Vercel Blob using deployment OIDC. A separate unverified builder project publishes pull-request artifacts to an isolated Blob store; the trusted package host proxies both artifact classes from its permanent domain.

```text
/main/eve.tgz
/main/latest.json
/<full-sha>/eve.tgz
/unverified/sha/<full-sha>/eve.tgz
/unverified/pr/<number>/eve.tgz
/unverified/pr/<number>/latest.json
```

The publisher uses Vercel's `VERCEL_PROJECT_PRODUCTION_URL` system environment variable as the public package domain. For example, if the production domain is `pkg.eve.dev`, initialize an agent from the current `main` build with:

```bash
npm exec --yes --package=https://pkg.eve.dev/main/eve.tgz -- eve init my-agent
```

Trusted `main` builds stamp immutable `/<sha>/eve.tgz` dependencies into generated projects. An unverified package stamps its immutable `/unverified/sha/<sha>/eve.tgz` dependency instead. The pull-request URL is a short-lived convenience redirect and must not be used as a pinned dependency.

## Trust boundaries

The trusted publisher project must:

- use this directory as its project root;
- enable access to Vercel system environment variables;
- deploy `main` to Production;
- connect only the trusted private Blob store;
- omit `BLOB_READ_WRITE_TOKEN` so Blob writes use Vercel OIDC; and
- disable Deployment Protection so npm can reach the production origin anonymously.

An unverified builder must be a **separate** Vercel project connected only to a separate private Blob store. Give it `EVE_PACKAGE_ARTIFACT_SCOPE=unverified` and `EVE_PACKAGE_PUBLIC_ORIGIN=https://pkg.eve.dev` for Preview deployments. It must never receive the trusted Blob connection, a production secret, or any credential that can access trusted artifacts. Configure it with the same root and build command; Preview builds write immutable SHA artifacts and an optional mutable PR pointer when `EVE_PULL_REQUEST_NUMBER` is set.

The unverified builder needs write access only to the unverified store. The trusted package host reads that store with `EVE_UNVERIFIED_BLOB_READ_WRITE_TOKEN` in its Production environment and proxies it through `pkg.eve.dev`; never configure that token in the unverified builder.

Only `main` builds may run in the trusted project. Set its Ignored Build Step to:

```sh
test "$VERCEL_GIT_COMMIT_REF" != "main"
```

This skips every non-main revision before dependency installation and prevents untrusted branch code from running with the trusted project’s Blob access. The separate unverified builder is the only project that builds Preview branches. The smoke check verifies public access and the downloaded artifact's gzip signature.
