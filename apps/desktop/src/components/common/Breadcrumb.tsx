import { Breadcrumbs, Link, Typography } from "@mui/material";
import { ChevronRight } from "lucide-react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";

export type BreadcrumbItem = {
  label: string;
  href?: string;
  onClick?: () => void;
};

export type BreadcrumbProps = {
  items: BreadcrumbItem[];
};

const chevron = <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />;

export const Breadcrumb = ({ items }: BreadcrumbProps) => {
  const navigate = useNavigate();
  const intl = useIntl();

  if (items.length === 0) {
    return null;
  }

  const handleClick = (item: BreadcrumbItem) => {
    if (item.onClick) {
      item.onClick();
      return;
    }
    if (item.href) {
      navigate(item.href);
    }
  };

  return (
    <Breadcrumbs
      aria-label={intl.formatMessage({ defaultMessage: "Breadcrumb" })}
      separator={chevron}
      sx={{
        minWidth: 0,
        "& .MuiBreadcrumbs-ol": { flexWrap: "nowrap" },
        "& .MuiBreadcrumbs-li": { minWidth: 0 },
      }}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        const itemKey = `${index}:${item.href ?? ""}:${item.label}`;
        const trunc = {
          whiteSpace: "nowrap" as const,
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 220,
        };
        if (isLast) {
          return (
            <Typography
              key={itemKey}
              variant="body2"
              aria-current="page"
              sx={{
                color: "text.primary",
                fontWeight: 500,
                ...trunc,
              }}
            >
              {item.label}
            </Typography>
          );
        }
        return (
          <Link
            key={itemKey}
            component="button"
            type="button"
            variant="body2"
            onClick={() => handleClick(item)}
            sx={{
              color: "text.secondary",
              cursor: "pointer",
              textDecoration: "none",
              ...trunc,
              "&:hover": { textDecoration: "underline", color: "text.primary" },
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </Breadcrumbs>
  );
};
