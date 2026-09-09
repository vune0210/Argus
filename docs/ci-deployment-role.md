# CI deployment-role proposal

The confirmed GitHub repository is `vune0210/Argus`. Create the staging GitHub OIDC role with a trust policy restricted to the `repo:vune0210/Argus:environment:staging` subject and the `sts.amazonaws.com` audience. Its permissions must cover only the Argus staging ECR repositories and staging Terraform role; do not grant wildcard administrator access or production trust.

If production deployment is enabled later, use a separate role restricted to `repo:vune0210/Argus:environment:production` and protect the GitHub `production` environment with the required reviewers.
