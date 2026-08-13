# eve package artifacts

The trusted package project builds an eve tarball from each `vercel/eve` `main` commit and uploads immutable SHA-addressed artifacts to private Vercel Blob using deployment OIDC. Preview deployments package their own checkout into static output; they do not use Blob.

```text
/main/eve.tgz
/main/latest.json
/<full-sha>/eve.tgz
```

The publisher uses Vercel's `VERCEL_PROJECT_PRODUCTION_URL` system environment variable as the public package domain. For example, if the production domain is `pkg.eve.dev`, initialize an agent from the current `main` build with:

```bash
npm exec --yes --package=https://pkg.eve.dev/main/eve.tgz -- eve init my-agent
```

Trusted `main` builds stamp immutable `/<sha>/eve.tgz` dependencies into generated projects. A Preview build writes `eve.tgz` to its own deployment output and stamps that deployment's immutable `https://<deployment>/eve.tgz` URL instead. Preview URLs are explicitly for testing unreviewed code and are never published through the trusted package host.

## Trust boundary

The trusted package project must:

- use this directory as its project root;
- enable access to Vercel system environment variables;
- deploy `main` to Production;
- connect the trusted private Blob store to Production only;
- omit `BLOB_READ_WRITE_TOKEN` so Blob writes use Vercel OIDC; and
- disable Deployment Protection so npm can reach the production origin anonymously.

Only `main` builds may run in the trusted project. Set its Ignored Build Step to:

```sh
test "$VERCEL_GIT_COMMIT_REF" != "main"
```

This skips every non-main revision before dependency installation and prevents untrusted branch code from running with the trusted project's Blob access. The smoke check verifies public access and the downloaded artifact's gzip signature.

To build Preview package artifacts, use a separate Vercel project with the same root and build command, no Blob connection, no package-host credentials, and no production secrets. It must permit Preview deployments and skip Production deployments:

```sh
test "$VERCEL_ENV" = "production"
```

The Preview project's deployment URL is the artifact host. The generated package is self-contained: a project initialized from it continues to pin the same Preview deployment's `/eve.tgz` URL.
