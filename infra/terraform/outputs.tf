output "vpc_id" {
  value = aws_vpc.control_plane.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "ecr_repository_urls" {
  value = { for name, repository in aws_ecr_repository.service : name => repository.repository_url }
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.argus.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "app_private_subnet_ids" {
  value = aws_subnet.app_private[*].id
}

output "data_private_subnet_ids" {
  value = aws_subnet.data_private[*].id
}

output "alb_dns_name" {
  value = aws_lb.control_plane.dns_name
}

output "alb_arn" {
  value = aws_lb.control_plane.arn
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.status_page.domain_name
}

output "control_plane_url" {
  value = "https://api.${var.domain_name}"
}
