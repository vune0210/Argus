# AWS foundation

The root stack creates the week-one VPC, non-ingress security group, ECR repositories, CloudWatch log groups, and Cognito user pool/client. It does not deploy workloads or grant production access.

Create remote state once:

```bash
terraform -chdir=bootstrap init
terraform -chdir=bootstrap apply -var="name_prefix=argus"
```

Copy `backend.hcl.example`, replace the bucket name with the bootstrap output, then validate/plan the foundation:

```bash
terraform init -backend-config=backend.hcl
terraform validate
terraform plan -var-file=terraform.tfvars
```

Do not apply with example callback URLs or a placeholder Cognito domain.
