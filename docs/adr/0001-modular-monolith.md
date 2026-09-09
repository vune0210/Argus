# ADR 0001: Modular control plane

Status: accepted

The API and product-domain modules ship as a modular NestJS monolith. Background work runs in separately deployable processes while sharing versioned domain packages. This preserves transaction boundaries and delivery speed without preventing later extraction.
