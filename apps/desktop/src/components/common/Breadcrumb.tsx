import { Breadcrumbs, Link, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";

export type BreadcrumbItem = {
  label: string;
  href?: string;
  onClick?: () => void;
};

export type BreadcrumbProps = {
  items: BreadcrumbItem[];
  separator?: string;
};

export const Breadcrumb = ({ items, separator = "/" }: BreadcrumbProps) => {
  const navigate = useNavigate();

  const handleClick = (item: BreadcrumbItem) => {
    if (item.onClick) {
      item.onClick();
    } else if (item.href) {
      navigate(item.href);
    }
  };

  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      maxItems={3}
      separator={separator}
      sx={{ px: 2, minWidth: 0 }}
    >
      {items.map((item, index) =>
        index === items.length - 1 ? (
          <Typography
            key={index}
            variant="body2"
            aria-current="page"
            sx={{
              color: "text.primary",
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.label}
          </Typography>
        ) : (
          <Link
            key={index}
            component="button"
            variant="body2"
            onClick={() => handleClick(item)}
            sx={{
              color: "text.secondary",
              cursor: "pointer",
              textDecoration: "none",
              whiteSpace: "nowrap",
              "&:hover": { textDecoration: "underline" },
            }}
          >
            {item.label}
          </Link>
        ),
      )}
    </Breadcrumbs>
  );
};
