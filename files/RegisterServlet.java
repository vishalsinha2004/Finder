import java.io.*;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import jakarta.servlet.annotation.*;
import java.sql.*;

@WebServlet("/register")
public class RegisterServlet extends HttpServlet {
    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        response.setContentType("text/html");
        PrintWriter out = response.getWriter();

        String name = request.getParameter("name");
        String email = request.getParameter("email");

        try {
            // Load MySQL driver
            Class.forName("com.mysql.cj.jdbc.Driver");

            // Connect to DB
            Connection con = DriverManager.getConnection(
                "jdbc:mysql://localhost:3306/userDB", "root", "your_password"
            );

            // Prepare SQL query
            String query = "INSERT INTO users (name, email) VALUES (?, ?)";
            PreparedStatement pst = con.prepareStatement(query);
            pst.setString(1, name);
            pst.setString(2, email);

            int rowCount = pst.executeUpdate();
            if (rowCount > 0) {
                out.println("<h2>Registration Successful!</h2>");
            } else {
                out.println("<h2>Registration Failed!</h2>");
            }

            pst.close();
            con.close();

        } catch (Exception e) {
            out.println("<h2>Error: " + e.getMessage() + "</h2>");
        }
    }
}
